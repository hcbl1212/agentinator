import type { EventPayloads, EventType, ImageAttachment, ResumeTurn } from '../../shared/events'

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
  /** Images attached to the opening message (pasted screenshots). */
  images?: ImageAttachment[]
  /** Present when reopening a prior session: a vendor-native token (used by
   * providers that support native resume, e.g. Claude) and the conversation
   * turns from the log (for providers that replay). When set, the provider
   * does NOT send an opening prompt — the reply arrives via send(). */
  resume?: { token?: string; turns: ResumeTurn[] }
}

export interface AgentSessionHandle {
  /** Steer the running session with an additional message and any images. */
  send(text: string, images?: ImageAttachment[]): Promise<void>
  /** Stop the session; the provider must still emit session.ended. */
  cancel(): Promise<void>
}

export interface AgentProvider {
  readonly id: string
  /** Human-facing name of the vendor/agent (e.g. "Claude"). The UI shows this
   * instead of hardcoding a vendor — the provider layer owns its own name. */
  readonly label: string
  readonly capabilities: ProviderCapabilities
  startSession(context: SessionContext, emit: EmitEvent): AgentSessionHandle
}
