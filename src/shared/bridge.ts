import type { StoredEvent } from './events'

/** Window during which a resolved approval can still be undone before it
 * reaches the agent. Shared so the broker's timer and the card's countdown
 * agree. */
export const APPROVAL_GRACE_MS = 5000

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
    /** Schedule a decision; it reaches the agent only after the grace window. */
    resolve(requestId: string, approved: boolean): Promise<void>
    /** Abort a scheduled decision before the grace window closes. */
    undo(requestId: string): Promise<void>
  }
}
