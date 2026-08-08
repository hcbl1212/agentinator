import type { EventPayloads, EventType } from '../../shared/events'

/**
 * The vendor abstraction. Adapters implement AgentProvider and emit ONLY
 * normalized events (shared/events.ts) — vendor-specific payload shapes never
 * cross this boundary. Consumers check capabilities, never the provider id.
 */
export interface ProviderCapabilities {
  vision: boolean
  toolUse: boolean
  streaming: boolean
  promptCaching: boolean
  taskBudgets: boolean
  batchApi: boolean
  nativeSkills: boolean
  contextWindowTokens: number
}

export type EmitEvent = <T extends EventType>(type: T, payload: EventPayloads[T]) => void

/**
 * Asks the harness for permission before a side-effecting tool runs.
 * Resolves true/false — possibly only after a human clicks a card.
 */
export type PermissionDecider = (
  sessionId: string,
  tool: string,
  input: unknown,
) => Promise<boolean>

export interface SessionContext {
  sessionId: string
  workspaceId: string
  agentId: string
  title: string
  prompt: string
  cwd: string
  model?: string
}

export interface AgentSessionHandle {
  /** Steer the running session with an additional message. */
  send(text: string): Promise<void>
  /** Stop the session; the provider must still emit session.ended. */
  cancel(): Promise<void>
}

export interface AgentProvider {
  readonly id: string
  readonly capabilities: ProviderCapabilities
  startSession(context: SessionContext, emit: EmitEvent): AgentSessionHandle
}
