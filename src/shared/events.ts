/**
 * The normalized event schema — the one language every part of Agentinator
 * speaks. Vendor adapters map their payloads INTO these types; the UI renders
 * FROM them. Schema evolution is append-only: add new event types, never
 * mutate or repurpose existing ones (old logs must replay forever).
 */

import type { AccountLimit, AccountUsage } from './usage'

export const ENTITY_KINDS = ['workspace', 'repo', 'session', 'agent', 'task', 'approval'] as const

export type EntityKind = (typeof ENTITY_KINDS)[number]

export function createEntityId(kind: EntityKind): string {
  return `${kind}_${crypto.randomUUID()}`
}

/** A base64 image attached to a message (e.g. a pasted screenshot), carried to
 * vision-capable providers. `data` is base64 with no data-URL prefix. */
export interface ImageAttachment {
  mediaType: string
  data: string
}

/** One turn of a prior conversation, reconstructed from the log — the
 * vendor-agnostic material any provider can replay to resume a session. */
export interface ResumeTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface EventPayloads {
  /** Emitted once per app launch — proves the fabric end-to-end. */
  'app.started': { version: string }
  'session.started': {
    sessionId: string
    agentId: string
    workspaceId: string
    title: string
    /** The provider running the session (e.g. "claude") — shown per agent. */
    providerId?: string
  }
  'session.ended': { sessionId: string; outcome: 'completed' | 'cancelled' | 'failed' }
  'agent.text': { sessionId: string; text: string }
  'agent.thinking': { sessionId: string; summary: string }
  /** A turn finished; the session is alive and awaiting a follow-up message. */
  'session.idle': { sessionId: string }
  /** The model the session is actually running, captured from the provider's
   * stream (the SDK reports it) — shown per agent in the rail. */
  'session.model': { sessionId: string; model: string }
  /** Which credential the provider authenticated with — surfaced so switching
   * an agent onto a metered API key is visible. */
  'session.auth': { sessionId: string; source: string }
  /** The credential the manager handed the session — emitted immediately on
   * start/resume/switch so the rail toggle reflects the choice at once, before
   * the provider confirms it via session.auth. */
  'session.credential': { sessionId: string; metered: boolean }
  /** A vendor-native token that can reopen this conversation after a restart
   * (e.g. the Claude SDK session id). Persisted so resume survives the app. */
  'session.resumable': { sessionId: string; resumeToken: string }
  /** A dead session was reopened and is live again. */
  'session.resumed': { sessionId: string }
  /** The agent is asking the user to choose — answered via a follow-up. */
  'agent.question': {
    sessionId: string
    requestId: string
    questions: Array<{ question: string; options: string[] }>
  }
  /** A user message sent into an ongoing session (steering / reply).
   * imageCount is present (>0) when screenshots were attached — the bytes go to
   * the model, not the log; an added optional field keeps old logs replaying. */
  'user.message': { sessionId: string; text: string; imageCount?: number }
  'tool.called': { sessionId: string; callId: string; tool: string; input: unknown }
  'tool.resulted': { sessionId: string; callId: string; ok: boolean; output: string }
  'file.diffed': {
    sessionId: string
    path: string
    additions: number
    deletions: number
    patch: string
  }
  'cost.usage': {
    sessionId: string
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    usd: number
  }
  /** The account's billing posture (plan/limits/overage), sampled from the
   * provider — drives the status bar, not the per-session conversation. */
  'account.usage': { sessionId: string } & AccountUsage
  /** A live rate-limit signal (approaching or hit) pushed by the provider —
   * drives the capacity card. The manager stamps providerId so the card knows
   * which vendor's key a switch would use. */
  'account.limit': { sessionId: string; providerId?: string } & AccountLimit
  /** A tool use is waiting on permission — the audit trail starts here. */
  'approval.requested': { sessionId: string; requestId: string; tool: string; input: unknown }
  'approval.resolved': {
    sessionId: string
    requestId: string
    approved: boolean
    via: 'allowlist' | 'user'
  }
  /** A spend ceiling (session or a time window) was crossed. */
  'budget.exceeded': {
    sessionId: string
    scope: import('./budget').BudgetScope
    usedUsd: number
    capUsd: number
  }
}

export type EventType = keyof EventPayloads

/** An event as it exists in the log: sequenced, timestamped, immutable. */
export interface StoredEvent<T extends EventType = EventType> {
  seq: number
  ts: string
  type: T
  payload: EventPayloads[T]
}
