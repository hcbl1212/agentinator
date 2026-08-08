import { createEntityId } from '../shared/events'
import type { StoredEvent } from '../shared/events'
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

/**
 * Owns the provider registry and the running sessions. Every provider event
 * is appended to the event log first (source of truth), then forwarded to
 * onEvent for live listeners (the renderer broadcast).
 */
export class SessionManager {
  #providers = new Map<string, AgentProvider>()
  #handles = new Map<string, AgentSessionHandle>()
  #endedEarly = new Set<string>()
  readonly #store: EventStore
  readonly #onEvent: (event: StoredEvent) => void

  constructor(store: EventStore, onEvent: (event: StoredEvent) => void = () => undefined) {
    this.#store = store
    this.#onEvent = onEvent
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

  start(options: StartSession): string {
    const provider = this.#providers.get(options.providerId)
    if (provider === undefined) {
      throw new Error(`Unknown provider: ${options.providerId}`)
    }

    const sessionId = createEntityId('session')
    const workspaceId = options.workspaceId ?? createEntityId('workspace')
    const agentId = options.agentId ?? createEntityId('agent')

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
        }
        this.#onEvent(stored)
      },
    )

    if (this.#endedEarly.delete(sessionId)) {
      return sessionId
    }
    this.#handles.set(sessionId, handle)
    return sessionId
  }

  async cancel(sessionId: string): Promise<void> {
    const handle = this.#handles.get(sessionId)
    if (handle !== undefined) {
      await handle.cancel()
    }
  }
}
