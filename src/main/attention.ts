import type { EventPayloads, StoredEvent } from '../shared/events'

/** How the tracker reaches the OS — a native notification, and the dock badge
 * count. Injected so the tracking logic is testable without Electron. */
export interface AttentionNotifier {
  notify: (title: string, body: string) => void
  setBadge: (count: number) => void
}

/**
 * Main-process side of the attention inbox: watches the event stream and, when
 * an agent starts (or stops) needing you, fires a native notification and keeps
 * the dock badge equal to the number of open items. Mirrors the renderer's
 * inbox reducer, but for OS integration that must work with the window
 * unfocused or hidden.
 */
export class AttentionTracker {
  #open = new Map<string, { sessionId: string; kind: 'approval' | 'question' }>()
  #deps: AttentionNotifier

  constructor(deps: AttentionNotifier) {
    this.#deps = deps
  }

  observe(event: StoredEvent): void {
    switch (event.type) {
      case 'approval.requested': {
        const payload = event.payload as EventPayloads['approval.requested']
        this.#add(`a:${payload.requestId}`, payload.sessionId, 'approval', {
          title: 'Approval needed',
          body: `An agent wants to run ${payload.tool}`,
        })
        break
      }
      case 'approval.resolved': {
        this.#remove(`a:${(event.payload as EventPayloads['approval.resolved']).requestId}`)
        break
      }
      case 'agent.question': {
        const payload = event.payload as EventPayloads['agent.question']
        this.#add(`q:${payload.requestId}`, payload.sessionId, 'question', {
          title: 'Agent has a question',
          body: payload.questions[0]?.question ?? 'An agent needs a decision',
        })
        break
      }
      case 'user.message': {
        // Replying answers whatever it asked.
        this.#clear((event.payload as EventPayloads['user.message']).sessionId, 'question')
        break
      }
      case 'session.ended': {
        const payload = event.payload as EventPayloads['session.ended']
        this.#clear(payload.sessionId)
        if (payload.outcome === 'failed') {
          this.#deps.notify('Agent failed', 'A task ended with an error')
        }
        break
      }
      default:
        break
    }
  }

  #add(
    id: string,
    sessionId: string,
    kind: 'approval' | 'question',
    message: { title: string; body: string },
  ): void {
    if (this.#open.has(id)) {
      return
    }
    this.#open.set(id, { sessionId, kind })
    this.#deps.notify(message.title, message.body)
    this.#deps.setBadge(this.#open.size)
  }

  #remove(id: string): void {
    if (this.#open.delete(id)) {
      this.#deps.setBadge(this.#open.size)
    }
  }

  /** Drop a session's open items — all of them, or just one kind. */
  #clear(sessionId: string, kind?: 'approval' | 'question'): void {
    let changed = false
    for (const [id, item] of this.#open) {
      if (item.sessionId === sessionId && (kind === undefined || item.kind === kind)) {
        this.#open.delete(id)
        changed = true
      }
    }
    if (changed) {
      this.#deps.setBadge(this.#open.size)
    }
  }
}
