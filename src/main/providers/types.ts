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
  /** Can run a session under a metered API key instead of its default
   * (subscription) credential — the basis for "switch to API key" when a plan
   * limit is hit. Vendor-neutral: each adapter applies the key its own way. */
  meteredAuth: boolean
  /** Runs real file-editing tools, so each session should get its own git
   * worktree + branch to keep concurrent agents from sharing a working tree.
   * Scripted providers (mock/e2e) that never touch a real tree set this false,
   * so the manager doesn't create worktrees for them. */
  worktreeIsolation: boolean
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
  /** A metered API key to authenticate this session with, instead of the
   * default (subscription) credential — set when switching an agent to the API
   * after hitting a plan limit. Vendor-neutral; the adapter maps it to its own
   * auth mechanism. */
  apiKey?: string
  /** Deny file-editing and command-running tools for this session — a
   * planning/read-only stage that must not touch the working tree. The adapter
   * blocks its mutating tools (Edit/Write/Bash and the like). */
  readOnly?: boolean
  /** Extra system-prompt instructions for this session — an agent type's
   * standing guidance. The adapter layers it onto the base prompt (as a stable,
   * cacheable section). */
  instructions?: string
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
