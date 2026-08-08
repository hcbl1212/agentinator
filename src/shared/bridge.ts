import type { ImageAttachment, StoredEvent } from './events'

/** Grace window for a DENY before it reaches the agent — a mis-clicked deny
 * is the costly mistake, so it's undoable; approvals commit instantly.
 * Shared so the broker's timer and the card's countdown agree. */
export const DENY_GRACE_MS = 3000

export interface PendingApproval {
  requestId: string
  sessionId: string
  tool: string
  input: unknown
}

/** The agent a new task will run on — surfaced so the UI reflects the current
 * vendor/model instead of hardcoding one. */
export interface AgentDescriptor {
  providerId: string
  label: string
  model?: string
}

/**
 * The API the preload script exposes to the renderer as `window.agentinator`.
 * The renderer never touches Node or Electron directly — everything crosses
 * this typed bridge.
 */
export interface AgentinatorBridge {
  events: {
    count(): Promise<number>
    /** Lifetime spend across the whole log, for the status-bar readout. */
    totalCost(): Promise<number>
    /** The current cumulative diff per file — newest file.diffed per path. */
    diffs(): Promise<StoredEvent[]>
    list(afterSeq?: number): Promise<StoredEvent[]>
    /** Newest `limit` events oldest-first; with beforeSeq, the page before it. */
    tail(limit: number, beforeSeq?: number): Promise<StoredEvent[]>
    /** Whole-log substring search over type + payload, newest matches first. */
    search(query: string, limit: number): Promise<StoredEvent[]>
    /** Subscribe to live appends; returns an unsubscribe function. */
    onAppended(listener: (event: StoredEvent) => void): () => void
  }
  agent: {
    /** The agent a new task will run on (vendor label + optional model). */
    current(): Promise<AgentDescriptor>
    /** Launch the scripted mock session — writes real events into the log. */
    startDemo(): Promise<string>
    /** Launch a real agent on the workspace repo with a task prompt and any
     * attached images (pasted screenshots). */
    startTask(prompt: string, images?: ImageAttachment[]): Promise<string>
    /** Send a follow-up message (with any attached images) into a session. */
    send(sessionId: string, text: string, images?: ImageAttachment[]): Promise<void>
    cancel(sessionId: string): Promise<void>
  }
  settings: {
    /** Spend ceilings per scope (session + time windows). */
    getBudgets(): Promise<import('./budget').Budgets>
    setBudget(scope: import('./budget').BudgetScope, usd: number | null): Promise<void>
  }
  approvals: {
    pending(): Promise<PendingApproval[]>
    /** Schedule a decision; it reaches the agent only after the grace window. */
    resolve(requestId: string, approved: boolean): Promise<void>
    /** Abort a scheduled decision before the grace window closes. */
    undo(requestId: string): Promise<void>
  }
}
