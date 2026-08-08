import { BUDGET_SCOPES } from '../shared/budget'
import type { Budgets, BudgetScope } from '../shared/budget'
import { createEntityId } from '../shared/events'
import type { StoredEvent } from '../shared/events'
import { periodStartIso } from './budgetPeriods'
import type { EventStore } from './eventStore'
import type { AgentProvider, AgentSessionHandle } from './providers/types'

export interface StartSession {
  providerId: string
  title: string
  prompt: string
  cwd: string
  model?: string
  workspaceId?: string
  agentId?: string
}

const NO_BUDGETS: Budgets = { session: null, hour: null, day: null, week: null, month: null }

/**
 * Owns the provider registry and the running sessions. Every provider event
 * is appended to the event log first (source of truth), then forwarded to
 * onEvent for live listeners (the renderer broadcast).
 *
 * Budgets are time-bound: the session cap stops a single runaway session; the
 * hour/day/week/month caps stop a session that pushes a rolling calendar
 * window over its ceiling, and refuse to start a new session once a window is
 * already spent.
 */
export class SessionManager {
  #providers = new Map<string, AgentProvider>()
  #handles = new Map<string, AgentSessionHandle>()
  #endedEarly = new Set<string>()
  #sessionSpentUsd = new Map<string, number>()
  readonly #store: EventStore
  readonly #onEvent: (event: StoredEvent) => void
  readonly #getBudgets: () => Budgets
  readonly #now: () => Date

  constructor(
    store: EventStore,
    onEvent: (event: StoredEvent) => void = () => undefined,
    options: { getBudgets?: () => Budgets; now?: () => Date } = {},
  ) {
    this.#store = store
    this.#onEvent = onEvent
    // Read at start()/cost time so a settings change takes immediate effect.
    this.#getBudgets = options.getBudgets ?? (() => NO_BUDGETS)
    this.#now = options.now ?? (() => new Date())
  }

  register(provider: AgentProvider): void {
    this.#providers.set(provider.id, provider)
  }

  providerIds(): string[] {
    return [...this.#providers.keys()]
  }

  activeCount(): number {
    return this.#handles.size
  }

  #emit(event: StoredEvent): void {
    this.#onEvent(event)
  }

  /** The first time-window scope already at/over its cap, or null. */
  #windowAlreadySpent(
    budgets: Budgets,
  ): { scope: BudgetScope; usedUsd: number; capUsd: number } | null {
    for (const scope of BUDGET_SCOPES) {
      if (scope === 'session') {
        continue
      }
      const cap = budgets[scope]
      const since = periodStartIso(scope, this.#now())
      if (cap === null || since === null) {
        continue
      }
      const usedUsd = this.#store.costSinceUsd(since)
      if (usedUsd >= cap) {
        return { scope, usedUsd, capUsd: cap }
      }
    }
    return null
  }

  /** The first scope this session's latest spend pushed over its cap, or null. */
  #scopeOverBudget(
    sessionSpent: number,
    budgets: Budgets,
  ): { scope: BudgetScope; usedUsd: number; capUsd: number } | null {
    if (budgets.session !== null && sessionSpent > budgets.session) {
      return { scope: 'session', usedUsd: sessionSpent, capUsd: budgets.session }
    }
    for (const scope of BUDGET_SCOPES) {
      if (scope === 'session') {
        continue
      }
      const cap = budgets[scope]
      const since = periodStartIso(scope, this.#now())
      if (cap === null || since === null) {
        continue
      }
      const usedUsd = this.#store.costSinceUsd(since)
      if (usedUsd > cap) {
        return { scope, usedUsd, capUsd: cap }
      }
    }
    return null
  }

  start(options: StartSession): string {
    const provider = this.#providers.get(options.providerId)
    if (provider === undefined) {
      throw new Error(`Unknown provider: ${options.providerId}`)
    }

    const sessionId = createEntityId('session')
    const workspaceId = options.workspaceId ?? createEntityId('workspace')
    const agentId = options.agentId ?? createEntityId('agent')
    const budgets = this.#getBudgets()

    // Refuse to start if a time window is already spent — record a coherent
    // started → exceeded → failed lifecycle so the session is auditable.
    const blocked = this.#windowAlreadySpent(budgets)
    if (blocked !== null) {
      this.#emit(
        this.#store.append('session.started', {
          sessionId,
          agentId,
          workspaceId,
          title: options.title,
        }),
      )
      this.#emit(this.#store.append('budget.exceeded', { sessionId, ...blocked }))
      this.#emit(this.#store.append('session.ended', { sessionId, outcome: 'failed' }))
      return sessionId
    }

    const handle = provider.startSession(
      {
        sessionId,
        workspaceId,
        agentId,
        title: options.title,
        prompt: options.prompt,
        cwd: options.cwd,
        model: options.model,
      },
      (type, payload) => {
        const stored = this.#store.append(type, payload)
        if (type === 'session.ended') {
          // May fire before startSession returns (instant failures) — record
          // it so the handle registered below is cleaned up either way.
          if (!this.#handles.delete(sessionId)) {
            this.#endedEarly.add(sessionId)
          }
          this.#sessionSpentUsd.delete(sessionId)
        }
        this.#emit(stored)

        if (type === 'cost.usage') {
          const spent =
            (this.#sessionSpentUsd.get(sessionId) ?? 0) + (payload as { usd: number }).usd
          this.#sessionSpentUsd.set(sessionId, spent)
          const over = this.#scopeOverBudget(spent, this.#getBudgets())
          if (over !== null) {
            this.#emit(this.#store.append('budget.exceeded', { sessionId, ...over }))
            void this.cancel(sessionId)
          }
        }
      },
    )

    if (this.#endedEarly.delete(sessionId)) {
      return sessionId
    }
    this.#handles.set(sessionId, handle)
    return sessionId
  }

  /** Send a follow-up message into an ongoing session (steering / reply). */
  async send(sessionId: string, text: string): Promise<void> {
    const handle = this.#handles.get(sessionId)
    if (handle !== undefined) {
      this.#emit(this.#store.append('user.message', { sessionId, text }))
      await handle.send(text)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const handle = this.#handles.get(sessionId)
    if (handle !== undefined) {
      await handle.cancel()
    }
  }
}
