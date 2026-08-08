import type { StoredEvent } from './events'

export interface PendingApproval {
  requestId: string
  sessionId: string
  tool: string
  input: unknown
}

/**
 * The API the preload script exposes to the renderer as `window.agentinator`.
 * The renderer never touches Node or Electron directly — everything crosses
 * this typed bridge.
 */
export interface AgentinatorBridge {
  events: {
    count(): Promise<number>
    list(afterSeq?: number): Promise<StoredEvent[]>
    /** Newest `limit` events oldest-first; with beforeSeq, the page before it. */
    tail(limit: number, beforeSeq?: number): Promise<StoredEvent[]>
    /** Whole-log substring search over type + payload, newest matches first. */
    search(query: string, limit: number): Promise<StoredEvent[]>
    /** Subscribe to live appends; returns an unsubscribe function. */
    onAppended(listener: (event: StoredEvent) => void): () => void
  }
  agent: {
    /** Launch the scripted mock session — writes real events into the log. */
    startDemo(): Promise<string>
    cancel(sessionId: string): Promise<void>
  }
  approvals: {
    pending(): Promise<PendingApproval[]>
    /** The only path that resolves an approval — agents can never call it. */
    resolve(requestId: string, approved: boolean): Promise<void>
  }
}
