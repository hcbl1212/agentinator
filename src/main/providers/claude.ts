import { createEntityId } from '../../shared/events'
import type { ConsoleEntry, ImageAttachment, NetworkEntry } from '../../shared/events'
import { normalizeLimit, normalizeUsage } from '../../shared/usage'
import type { GitRunner } from '../git'
import { diffAgainstHead } from '../workspaceDiff'
import { assembleSystemPrompt } from './promptAssembly'
import type {
  AgentProvider,
  AgentSessionHandle,
  EmitEvent,
  PermissionDecider,
  SessionContext,
} from './types'

/**
 * Adapter for the Claude Agent SDK. The query function is injected — the
 * provider itself never imports the SDK, so tests exercise the full mapping
 * against synthetic streams with no API key and no network. SDK message
 * shapes are narrowed structurally (isRecord + field checks) rather than
 * typed against the SDK, so vendor type drift cannot leak past this file.
 *
 * Sessions are multi-turn conversations: the prompt is a streaming input the
 * adapter pushes follow-up messages into (send), so context carries across
 * turns. Each turn ends with a `result` → session.idle (alive, awaiting
 * input); the session ends only on cancel.
 */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
>

type SdkContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export type SdkUserMessage = {
  type: 'user'
  message: { role: 'user'; content: string | SdkContentBlock[] }
  parent_tool_use_id: null
  session_id: string
}

export interface ClaudeQueryArgs {
  prompt: string | AsyncIterable<SdkUserMessage>
  options: {
    cwd: string
    model?: string
    systemPrompt: string
    canUseTool?: CanUseTool
    /** SDK session id to resume — reloads the prior conversation. */
    resume?: string
    /** Replaces the subprocess env — used to force a metered API key. */
    env?: Record<string, string | undefined>
    /** In-process MCP servers exposing harness tools (e.g. the preview capture
     * tool that lets the agent see the app it's building). */
    mcpServers?: Record<string, unknown>
  }
}

/** An image a custom tool hands back to the model (base64, no data-URL prefix)
 * — the SDK's documented shape for image tool results. */
export interface SdkImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface SdkTextContent {
  type: 'text'
  text: string
}

export interface SdkToolResult {
  content: Array<SdkImageContent | SdkTextContent>
}

/** The SDK's `tool()` and `createSdkMcpServer()` builders, injected so this
 * adapter never imports the SDK (keeping it fully testable offline). */
export type SdkTool = (
  name: string,
  description: string,
  inputSchema: Record<string, never>,
  handler: () => Promise<SdkToolResult>,
) => unknown

export type SdkCreateServer = (config: {
  name: string
  version: string
  tools: unknown[]
}) => unknown

/**
 * The visual feedback loop, injected as a capability: capture the app for a
 * session (bytes to hand the model) plus the SDK builders to expose it as a
 * tool. Absent for providers/tests that don't wire a preview.
 */
export interface PreviewVision {
  capture: (sessionId: string) => Promise<{
    base64: string
    mediaType: string
    console: ConsoleEntry[]
    network: NetworkEntry[]
  }>
  tool: SdkTool
  createSdkMcpServer: SdkCreateServer
}

const PREVIEW_SERVER = 'preview'
const PREVIEW_TOOL = 'capture_app'
/** MCP tools are namespaced `mcp__{server}__{tool}` in the SDK. */
const PREVIEW_TOOL_QUALIFIED = `mcp__${PREVIEW_SERVER}__${PREVIEW_TOOL}`

/** The SDK's built-in tools that change the working tree or run commands —
 * denied outright for a read-only stage (e.g. planning), which may still read,
 * grep, and search. Matched case-insensitively so tool-name casing can't slip
 * an edit past the gate. */
const MUTATING_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'bash'])

/** The captured console rendered for the model — a text block it reads next to
 * the screenshot. Empty console yields no block (nothing to say). */
function consoleBlock(console: ConsoleEntry[]): SdkTextContent[] {
  if (console.length === 0) {
    return []
  }
  const lines = console.map((entry) => `[${entry.level}] ${entry.text}`).join('\n')
  return [{ type: 'text', text: `Console output from the app:\n${lines}` }]
}

/** The captured network activity for the model — a request summary plus the
 * failing calls spelled out, so it can see a broken API next to the pixels. */
function networkBlock(network: NetworkEntry[]): SdkTextContent[] {
  if (network.length === 0) {
    return []
  }
  const failed = network.filter((entry) => !entry.ok)
  const summary = `Network: ${network.length} request(s), ${failed.length} failed.`
  const detail = failed.map((entry) => `${entry.method} ${entry.url} → ${entry.status}`).join('\n')
  return [{ type: 'text', text: failed.length === 0 ? summary : `${summary}\n${detail}` }]
}

export type ClaudeQuery = (
  args: ClaudeQueryArgs,
) => AsyncIterable<unknown> & { interrupt?: () => Promise<void> }

const SYSTEM_BASE =
  'You are an Agentinator agent working inside a git repository. ' +
  'Follow the existing patterns of the codebase and keep changes scoped to the task.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function userMessage(text: string, images: ImageAttachment[] = []): SdkUserMessage {
  // Plain string when there are no images (keeps the cache-friendly shape);
  // a content-block array with base64 image blocks when there are.
  const content: string | SdkContentBlock[] =
    images.length === 0
      ? text
      : [
          { type: 'text', text },
          ...images.map((image): SdkContentBlock => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          })),
        ]
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  }
}

/** A queue an async-iterable input reads from — push adds a turn, end closes. */
function createInputStream(): {
  iterable: AsyncIterable<SdkUserMessage>
  push: (message: SdkUserMessage) => void
  end: () => void
} {
  const queue: SdkUserMessage[] = []
  let wake: (() => void) | null = null
  let ended = false
  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve
    })
  return {
    push: (message) => {
      queue.push(message)
      wake?.()
      wake = null
    },
    end: () => {
      ended = true
      wake?.()
      wake = null
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = queue.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          if (ended) {
            return
          }
          await wait()
        }
      },
    },
  }
}

function mapAssistantBlock(block: unknown, sessionId: string, emit: EmitEvent): void {
  if (!isRecord(block)) {
    return
  }
  if (block['type'] === 'text') {
    emit('agent.text', { sessionId, text: String(block['text']) })
  } else if (block['type'] === 'thinking') {
    emit('agent.thinking', { sessionId, summary: String(block['thinking']) })
  } else if (block['type'] === 'tool_use') {
    emit('tool.called', {
      sessionId,
      callId: String(block['id']),
      tool: String(block['name']),
      input: block['input'],
    })
  }
}

/** A tool result's content as a log-safe string. Base64 image payloads (agent
 * screenshots) are redacted so they never bloat the append-only log — the bytes
 * already live in the artifact store. Non-image content is unchanged. */
function compactToolOutput(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    // Redact base64 image payloads; leave every other block untouched (so
    // structured non-image results still stringify exactly as before).
    const redacted: unknown[] = content.map((block: unknown) =>
      isRecord(block) && block['type'] === 'image'
        ? { type: 'image', data: '[screenshot]' }
        : block,
    )
    return JSON.stringify(redacted)
  }
  return JSON.stringify(content)
}

function mapUserBlock(block: unknown, sessionId: string, emit: EmitEvent): void {
  if (!isRecord(block) || block['type'] !== 'tool_result') {
    return
  }
  emit('tool.resulted', {
    sessionId,
    callId: String(block['tool_use_id']),
    ok: block['is_error'] !== true,
    output: compactToolOutput(block['content']),
  })
}

interface MapContext {
  sessionId: string
  emit: EmitEvent
  /** Running total the SDK last reported for this session (see the result
   * handler) — mutated in place so each turn can bill only its delta. */
  cost: { lastTotalUsd: number }
}

/** Maps one SDK message; returns true on a turn boundary (a `result`). */
function mapSdkMessage(message: unknown, { sessionId, emit, cost }: MapContext): boolean {
  if (!isRecord(message)) {
    return false
  }
  const nested = message['message']
  if (message['type'] === 'assistant' && isRecord(nested) && Array.isArray(nested['content'])) {
    for (const block of nested['content']) {
      mapAssistantBlock(block, sessionId, emit)
    }
    return false
  }
  if (message['type'] === 'user' && isRecord(nested) && Array.isArray(nested['content'])) {
    for (const block of nested['content']) {
      mapUserBlock(block, sessionId, emit)
    }
    return false
  }
  if (message['type'] === 'rate_limit_event') {
    emit('account.limit', { sessionId, ...normalizeLimit(message['rate_limit_info']) })
    return false
  }
  if (message['type'] === 'result') {
    const usage = isRecord(message['usage']) ? message['usage'] : {}
    // total_cost_usd is the session's *running total*, not this turn's cost, so
    // bill the delta — otherwise every downstream sum (status bar, budgets)
    // double-counts. A zeroed crash/startup result won't drag the total back.
    const runningTotal = toNumber(message['total_cost_usd'])
    const turnUsd = Math.max(0, runningTotal - cost.lastTotalUsd)
    cost.lastTotalUsd = Math.max(cost.lastTotalUsd, runningTotal)
    emit('cost.usage', {
      sessionId,
      inputTokens: toNumber(usage['input_tokens']),
      outputTokens: toNumber(usage['output_tokens']),
      cacheReadInputTokens: toNumber(usage['cache_read_input_tokens']),
      usd: turnUsd,
    })
    emit('session.idle', { sessionId })
    return true
  }
  return false
}

/** Parses an AskUserQuestion tool input into normalized questions. */
function parseQuestions(input: Record<string, unknown>): Array<{
  question: string
  options: string[]
}> {
  const raw = Array.isArray(input['questions']) ? input['questions'] : []
  return raw.map((entry) => {
    const record = isRecord(entry) ? entry : {}
    const options = Array.isArray(record['options']) ? record['options'] : []
    const question = record['question']
    return {
      question: typeof question === 'string' ? question : '',
      options: options.map((option) =>
        isRecord(option)
          ? typeof option['label'] === 'string'
            ? option['label']
            : ''
          : String(option),
      ),
    }
  })
}

export function createClaudeProvider(
  query: ClaudeQuery,
  decide?: PermissionDecider,
  vision?: PreviewVision,
  // Runs git in the agent's working dir so the harness can render its edits as a
  // cumulative diff (the SDK reports edits only as opaque tool calls). Omitted →
  // no diffs (e.g. tests, or a non-git workspace).
  git?: GitRunner,
): AgentProvider {
  return {
    id: 'claude',
    label: 'Claude',
    capabilities: {
      vision: true,
      toolUse: true,
      streaming: true,
      promptCaching: true,
      taskBudgets: true,
      batchApi: true,
      nativeSkills: true,
      meteredAuth: true,
      worktreeIsolation: true,
      contextWindowTokens: 1_000_000,
    },
    startSession(context: SessionContext, emit: EmitEvent): AgentSessionHandle {
      const { sessionId } = context
      const input = createInputStream()
      // On resume the SDK reloads the conversation; the reply arrives via
      // send(). Fresh sessions open with the task prompt.
      if (context.resume === undefined) {
        input.push(userMessage(context.prompt, context.images))
      }

      const canUseTool: CanUseTool = async (toolName, toolInput) => {
        // Capturing the app is a safe, read-only look — never gate it behind an
        // approval card (allowedTools also pre-approves it; this is belt-and-braces).
        if (toolName === PREVIEW_TOOL_QUALIFIED) {
          return { behavior: 'allow', updatedInput: toolInput }
        }
        // The agent's own questions are not permission requests — surface them
        // as an answerable card and have the agent wait for a follow-up.
        if (toolName === 'AskUserQuestion') {
          emit('agent.question', {
            sessionId,
            requestId: createEntityId('approval'),
            questions: parseQuestions(toolInput),
          })
          return {
            behavior: 'deny',
            message:
              "Do not call AskUserQuestion. The user's answer will arrive as their next message — end your turn and wait for it.",
          }
        }
        // A read-only stage (planning) may read the code but must not change it
        // or run commands — hard-block its mutating tools, prompt notwithstanding.
        if (context.readOnly === true && MUTATING_TOOLS.has(toolName.toLowerCase())) {
          return {
            behavior: 'deny',
            message:
              'This is a read-only planning stage — you cannot edit files or run commands. ' +
              'Read and search as needed, then output a written plan.',
          }
        }
        if (decide === undefined) {
          return { behavior: 'allow', updatedInput: toolInput }
        }
        return (await decide(sessionId, toolName, toolInput))
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: 'Denied from an Agentinator approval card.' }
      }

      // Expose the app-capture tool when a preview is wired, so the agent can
      // look at what it's building and iterate on it visually. It's approved via
      // canUseTool (below), NOT allowedTools — a bare allowedTools entry would
      // auto-approve before the callback and the SDK warns about the shadowing.
      let mcpServers: Record<string, unknown> | undefined
      if (vision !== undefined) {
        const captureTool = vision.tool(
          PREVIEW_TOOL,
          'Capture a screenshot of the app you are building and see its current visual state. ' +
            'Use it to verify UI changes you have made.',
          {},
          async () => {
            const { base64, mediaType, console, network } = await vision.capture(sessionId)
            return {
              content: [
                ...consoleBlock(console),
                ...networkBlock(network),
                { type: 'image', data: base64, mimeType: mediaType },
              ],
            }
          },
        )
        mcpServers = {
          [PREVIEW_SERVER]: vision.createSdkMcpServer({
            name: PREVIEW_SERVER,
            version: '1.0.0',
            tools: [captureTool],
          }),
        }
      }

      const stream = query({
        prompt: input.iterable,
        options: {
          cwd: context.cwd,
          model: context.model,
          // An agent type's instructions layer onto the base as a second stable
          // section (still cacheable); the knowledge slice and per-run context
          // join later once they exist.
          systemPrompt: assembleSystemPrompt({
            stable:
              context.instructions === undefined
                ? [SYSTEM_BASE]
                : [SYSTEM_BASE, context.instructions],
            volatile: [],
          }),
          canUseTool,
          resume: context.resume?.token,
          mcpServers,
          // Force a metered API key when switching off the subscription. env
          // replaces the subprocess environment, so carry the rest of it over.
          env:
            context.apiKey === undefined
              ? undefined
              : { ...process.env, ANTHROPIC_API_KEY: context.apiKey },
        },
      })

      emit('session.started', {
        sessionId,
        agentId: context.agentId,
        workspaceId: context.workspaceId,
        title: context.title,
      })

      let ended = false
      const endOnce = (outcome: 'completed' | 'cancelled' | 'failed'): void => {
        if (!ended) {
          ended = true
          emit('session.ended', { sessionId, outcome })
        }
      }

      let tokenEmitted = false
      let modelEmitted = false
      let authEmitted = false
      // Per-session cost accumulator: the SDK reports a running total each turn;
      // this lets the mapper bill only the delta. A resumed session gets a fresh
      // closure (and the SDK restarts its total at 0), so deltas stay correct.
      const cost = { lastTotalUsd: 0 }
      // Sample the account's billing posture (plan / limits / overage) after a
      // turn, normalized behind our own type. The method is EXPERIMENTAL and
      // absent from mocked streams, so it's fully guarded — a usage hiccup must
      // never disturb the session.
      const reportUsage = async (): Promise<void> => {
        const control = stream as unknown as {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>
        }
        const fetchUsage = control.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
        if (typeof fetchUsage !== 'function') {
          return
        }
        try {
          const raw = await fetchUsage.call(control)
          emit('account.usage', { sessionId, ...normalizeUsage(raw) })
        } catch {
          // Experimental usage API — ignore any failure.
        }
      }
      // After a turn, render the agent's file edits as a cumulative diff. The
      // SDK surfaces edits only as opaque tool calls, so we ask git for the real
      // diff of the working dir. diffAgainstHead is best-effort and never throws
      // (git errors are swallowed), so a diff hiccup can't disturb the session.
      const reportDiff = async (): Promise<void> => {
        if (git === undefined) {
          return
        }
        for (const file of await diffAgainstHead(context.cwd, git)) {
          emit('file.diffed', { sessionId, ...file })
        }
      }
      const run = async (): Promise<void> => {
        try {
          for await (const message of stream) {
            // A cancel already closed the session — stop mapping late messages.
            if (ended) {
              break
            }
            if (isRecord(message)) {
              // Capture the SDK session id once — it resumes this conversation
              // after a restart.
              if (!tokenEmitted && typeof message['session_id'] === 'string') {
                tokenEmitted = true
                emit('session.resumable', { sessionId, resumeToken: message['session_id'] })
              }
              // Capture the model the SDK actually ran, once.
              const nested = message['message']
              if (
                !modelEmitted &&
                message['type'] === 'assistant' &&
                isRecord(nested) &&
                typeof nested['model'] === 'string'
              ) {
                modelEmitted = true
                emit('session.model', { sessionId, model: nested['model'] })
              }
              // Capture which credential the SDK authenticated with, once — so a
              // switch to the API key is visible ('none' = subscription login).
              if (
                !authEmitted &&
                message['type'] === 'system' &&
                message['subtype'] === 'init' &&
                typeof message['apiKeySource'] === 'string'
              ) {
                authEmitted = true
                emit('session.auth', { sessionId, source: message['apiKeySource'] })
              }
            }
            if (mapSdkMessage(message, { sessionId, emit, cost })) {
              void reportUsage()
              void reportDiff()
            }
          }
        } catch {
          endOnce('failed')
          return
        }
        // The stream ends only after input is closed (cancel/completion).
        endOnce('completed')
      }
      void run()

      return {
        send: (text, images) => {
          input.push(userMessage(text, images))
          return Promise.resolve()
        },
        cancel: async () => {
          input.end()
          if (typeof stream.interrupt === 'function') {
            await stream.interrupt()
          }
          endOnce('cancelled')
        },
      }
    },
  }
}
