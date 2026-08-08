import { createEntityId } from '../../shared/events'
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

export type SdkUserMessage = {
  type: 'user'
  message: { role: 'user'; content: string }
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
  }
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

function userMessage(text: string): SdkUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
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

function mapUserBlock(block: unknown, sessionId: string, emit: EmitEvent): void {
  if (!isRecord(block) || block['type'] !== 'tool_result') {
    return
  }
  const content = block['content']
  emit('tool.resulted', {
    sessionId,
    callId: String(block['tool_use_id']),
    ok: block['is_error'] !== true,
    output: typeof content === 'string' ? content : JSON.stringify(content),
  })
}

interface MapContext {
  sessionId: string
  emit: EmitEvent
}

/** Maps one SDK message; returns true on a turn boundary (a `result`). */
function mapSdkMessage(message: unknown, { sessionId, emit }: MapContext): boolean {
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
  if (message['type'] === 'result') {
    const usage = isRecord(message['usage']) ? message['usage'] : {}
    emit('cost.usage', {
      sessionId,
      inputTokens: toNumber(usage['input_tokens']),
      outputTokens: toNumber(usage['output_tokens']),
      cacheReadInputTokens: toNumber(usage['cache_read_input_tokens']),
      usd: toNumber(message['total_cost_usd']),
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
    return {
      question: String(record['question'] ?? ''),
      options: options.map((option) =>
        isRecord(option) ? String(option['label'] ?? '') : String(option),
      ),
    }
  })
}

export function createClaudeProvider(
  query: ClaudeQuery,
  decide?: PermissionDecider,
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
      contextWindowTokens: 1_000_000,
    },
    startSession(context: SessionContext, emit: EmitEvent): AgentSessionHandle {
      const { sessionId } = context
      const input = createInputStream()
      input.push(userMessage(context.prompt))

      const canUseTool: CanUseTool = async (toolName, toolInput) => {
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
        if (decide === undefined) {
          return { behavior: 'allow', updatedInput: toolInput }
        }
        return (await decide(sessionId, toolName, toolInput))
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: 'Denied from an Agentinator approval card.' }
      }

      const stream = query({
        prompt: input.iterable,
        options: {
          cwd: context.cwd,
          model: context.model,
          // Stable prefix only for now; the knowledge slice joins the stable
          // sections and per-run context joins volatile once they exist.
          systemPrompt: assembleSystemPrompt({ stable: [SYSTEM_BASE], volatile: [] }),
          canUseTool,
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

      const run = async (): Promise<void> => {
        try {
          for await (const message of stream) {
            // A cancel already closed the session — stop mapping late messages.
            if (ended) {
              break
            }
            mapSdkMessage(message, { sessionId, emit })
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
        send: (text) => {
          input.push(userMessage(text))
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
