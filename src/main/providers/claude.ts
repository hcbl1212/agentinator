import { assembleSystemPrompt } from './promptAssembly'
import type { AgentProvider, AgentSessionHandle, EmitEvent, SessionContext } from './types'

/**
 * Adapter for the Claude Agent SDK. The query function is injected — the
 * provider itself never imports the SDK, so tests exercise the full mapping
 * against synthetic streams with no API key and no network. SDK message
 * shapes are narrowed structurally (isRecord + field checks) rather than
 * typed against the SDK, so vendor type drift cannot leak past this file.
 */
export interface ClaudeQueryArgs {
  prompt: string
  options: {
    cwd: string
    model?: string
    systemPrompt: string
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
  isCancelled: () => boolean
}

/** Returns true when the message ended the session (a `result` message). */
function mapSdkMessage(message: unknown, { sessionId, emit, isCancelled }: MapContext): boolean {
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
    const outcome = isCancelled()
      ? 'cancelled'
      : message['subtype'] === 'success'
        ? 'completed'
        : 'failed'
    emit('session.ended', { sessionId, outcome })
    return true
  }
  return false
}

export function createClaudeProvider(query: ClaudeQuery): AgentProvider {
  return {
    id: 'claude',
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
      let cancelled = false
      const { sessionId } = context

      const stream = query({
        prompt: context.prompt,
        options: {
          cwd: context.cwd,
          model: context.model,
          // Stable prefix only for now; the knowledge slice joins the stable
          // sections and per-run context joins volatile once they exist.
          systemPrompt: assembleSystemPrompt({ stable: [SYSTEM_BASE], volatile: [] }),
        },
      })

      emit('session.started', {
        sessionId,
        agentId: context.agentId,
        workspaceId: context.workspaceId,
        title: context.title,
      })

      const run = async (): Promise<void> => {
        let ended = false
        try {
          for await (const message of stream) {
            ended =
              mapSdkMessage(message, { sessionId, emit, isCancelled: () => cancelled }) || ended
          }
        } catch {
          emit('session.ended', { sessionId, outcome: 'failed' })
          return
        }
        if (!ended) {
          emit('session.ended', { sessionId, outcome: cancelled ? 'cancelled' : 'failed' })
        }
      }
      void run()

      return {
        send: () =>
          Promise.reject(
            new Error('Steering the Claude session is not supported yet (arrives with pipelines).'),
          ),
        cancel: async () => {
          cancelled = true
          if (typeof stream.interrupt === 'function') {
            await stream.interrupt()
          }
        },
      }
    },
  }
}
