import { BUDGET_SCOPES } from '../shared/budget'
import type { Budgets, BudgetScope } from '../shared/budget'
import { createEntityId } from '../shared/events'
import type { EventPayloads, ImageAttachment, ResumeTurn, StoredEvent } from '../shared/events'
import { periodStartIso } from './budgetPeriods'
import type { EventStore } from './eventStore'
import type { AgentProvider, AgentSessionHandle, EmitEvent } from './providers/types'

export interface StartSession {
  providerId: string
  title: string
  prompt: string
  cwd: string
  model?: string
  workspaceId?: string
  agentId?: string
  /** Images attached to the opening message (pasted screenshots). */
  images?: ImageAttachment[]
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
  /** Sessions mid credential-switch: their old handle's session.ended is
   * suppressed so the agent keeps its place while it reconnects under a key. */
  #switching = new Set<string>()
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

  /** A provider's public descriptor (id + human label), or undefined. */
  describeProvider(id: string): { providerId: string; label: string } | undefined {
    const provider = this.#providers.get(id)
    return provider === undefined ? undefined : { providerId: provider.id, label: provider.label }
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
          providerId: options.providerId,
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
        images: options.images,
      },
      this.#sessionEmitter(sessionId, options.providerId),
    )

    if (this.#endedEarly.delete(sessionId)) {
      return sessionId
    }
    // Log the opening prompt as a user message so the timeline shows what you
    // typed, not just the session title.
    const imageCount = options.images?.length ?? 0
    this.#emit(
      this.#store.append(
        'user.message',
        imageCount > 0
          ? { sessionId, text: options.prompt, imageCount }
          : { sessionId, text: options.prompt },
      ),
    )
    this.#handles.set(sessionId, handle)
    return sessionId
  }

  /** The provider-event callback for a session: appends each event (stamping
   * the provider on session.started), forwards it, cleans up on end, and
   * enforces the session/window budget on cost. Shared by start and resume. */
  #sessionEmitter(sessionId: string, providerId: string): EmitEvent {
    return (type, payload) => {
      if (type === 'session.ended' && this.#switching.has(sessionId)) {
        // A credential switch stops the old stream; the session lives on under a
        // new key, so drop the end — don't record it or remove it from the rail.
        this.#handles.delete(sessionId)
        this.#sessionSpentUsd.delete(sessionId)
        return
      }
      const stored =
        type === 'session.started'
          ? this.#store.append('session.started', {
              ...(payload as EventPayloads['session.started']),
              providerId,
            })
          : type === 'account.limit'
            ? this.#store.append('account.limit', {
                ...(payload as EventPayloads['account.limit']),
                providerId,
              })
            : this.#store.append(type, payload)
      if (type === 'session.ended') {
        // May fire before startSession returns (instant failures) — record it
        // so the handle registered by the caller is cleaned up either way.
        if (!this.#handles.delete(sessionId)) {
          this.#endedEarly.add(sessionId)
        }
        this.#sessionSpentUsd.delete(sessionId)
      }
      this.#emit(stored)

      if (type === 'cost.usage') {
        const spent = (this.#sessionSpentUsd.get(sessionId) ?? 0) + (payload as { usd: number }).usd
        this.#sessionSpentUsd.set(sessionId, spent)
        const over = this.#scopeOverBudget(spent, this.#getBudgets())
        if (over !== null) {
          this.#emit(this.#store.append('budget.exceeded', { sessionId, ...over }))
          void this.cancel(sessionId)
        }
      }
    }
  }

  /**
   * Reopen a session with no live handle (the app restarted, or it was
   * orphaned). Rebuilds the provider session from the log: the provider gets a
   * vendor-native resume token when one was captured and the conversation turns
   * for vendors that replay. Returns the new handle, or undefined when the
   * session can't be resumed (unknown session or provider no longer registered).
   */
  #resume(sessionId: string, apiKey?: string): AgentSessionHandle | undefined {
    const events = this.#store.listBySession(sessionId)
    const started = events.find((event) => event.type === 'session.started')?.payload as
      EventPayloads['session.started'] | undefined
    const providerId = started?.providerId
    if (started === undefined || providerId === undefined) {
      return undefined
    }
    const provider = this.#providers.get(providerId)
    if (provider === undefined) {
      return undefined
    }
    const resumable = [...events].reverse().find((event) => event.type === 'session.resumable')
      ?.payload as EventPayloads['session.resumable'] | undefined
    const turns: ResumeTurn[] = events.flatMap((event): ResumeTurn[] => {
      if (event.type === 'user.message') {
        return [{ role: 'user', text: (event.payload as EventPayloads['user.message']).text }]
      }
      if (event.type === 'agent.text') {
        return [{ role: 'assistant', text: (event.payload as EventPayloads['agent.text']).text }]
      }
      return []
    })
    const handle = provider.startSession(
      {
        sessionId,
        workspaceId: started.workspaceId,
        agentId: started.agentId,
        title: started.title,
        prompt: '',
        cwd: process.cwd(),
        resume: { token: resumable?.resumeToken, turns },
        apiKey,
      },
      this.#sessionEmitter(sessionId, providerId),
    )
    if (this.#endedEarly.delete(sessionId)) {
      return undefined
    }
    this.#handles.set(sessionId, handle)
    this.#emit(this.#store.append('session.resumed', { sessionId }))
    return handle
  }

  /** Send a follow-up message (with any attached images) into a session,
   * reopening it first if its live handle is gone (e.g. after a restart). */
  async send(sessionId: string, text: string, images?: ImageAttachment[]): Promise<void> {
    const handle = this.#handles.get(sessionId) ?? this.#resume(sessionId)
    if (handle !== undefined) {
      const imageCount = images?.length ?? 0
      // Record that images were sent (a count, not the bytes); the model gets
      // the bytes via the handle.
      this.#emit(
        this.#store.append(
          'user.message',
          imageCount > 0 ? { sessionId, text, imageCount } : { sessionId, text },
        ),
      )
      await handle.send(text, images)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const handle = this.#handles.get(sessionId)
    if (handle !== undefined) {
      await handle.cancel()
    }
  }

  /** Reconnect a session under a different credential without ending it: pass a
   * metered API key to switch onto the API, or omit it to return to the
   * default (subscription) login. The old stream is stopped quietly so the
   * agent keeps its place. */
  async switchCredential(sessionId: string, apiKey?: string): Promise<void> {
    const handle = this.#handles.get(sessionId)
    if (handle !== undefined) {
      this.#switching.add(sessionId)
      await handle.cancel()
      this.#switching.delete(sessionId)
    }
    this.#resume(sessionId, apiKey)
  }

  /** Remove an agent from the fleet. A live session is cancelled (its provider
   * ends it); one with no live handle (idle after a restart, or already failed)
   * is closed by recording the end directly, so it drops off the rail and a
   * later restart won't reopen it. */
  async dismiss(sessionId: string): Promise<void> {
    const handle = this.#handles.get(sessionId)
    if (handle !== undefined) {
      await handle.cancel()
    } else {
      this.#emit(this.#store.append('session.ended', { sessionId, outcome: 'cancelled' }))
    }
  }
}
