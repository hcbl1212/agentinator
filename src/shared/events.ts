/**
 * The normalized event schema — the one language every part of Agentinator
 * speaks. Vendor adapters map their payloads INTO these types; the UI renders
 * FROM them. Schema evolution is append-only: add new event types, never
 * mutate or repurpose existing ones (old logs must replay forever).
 */

export const ENTITY_KINDS = ['workspace', 'repo', 'session', 'agent', 'task', 'approval'] as const

export type EntityKind = (typeof ENTITY_KINDS)[number]

export function createEntityId(kind: EntityKind): string {
  return `${kind}_${crypto.randomUUID()}`
}

export interface EventPayloads {
  /** Emitted once per app launch — proves the fabric end-to-end. */
  'app.started': { version: string }
  'session.started': { sessionId: string; agentId: string; workspaceId: string; title: string }
  'session.ended': { sessionId: string; outcome: 'completed' | 'cancelled' | 'failed' }
  'agent.text': { sessionId: string; text: string }
  'agent.thinking': { sessionId: string; summary: string }
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
  /** A tool use is waiting on permission — the audit trail starts here. */
  'approval.requested': { sessionId: string; requestId: string; tool: string; input: unknown }
  'approval.resolved': {
    sessionId: string
    requestId: string
    approved: boolean
    via: 'allowlist' | 'user'
  }
  /** The session crossed its spend ceiling and was stopped. */
  'budget.exceeded': { sessionId: string; usedUsd: number; capUsd: number }
}

export type EventType = keyof EventPayloads

/** An event as it exists in the log: sequenced, timestamped, immutable. */
export interface StoredEvent<T extends EventType = EventType> {
  seq: number
  ts: string
  type: T
  payload: EventPayloads[T]
}
