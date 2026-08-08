import { describe, expect, it, vi } from 'vitest'

import type { EventPayloads, EventType } from '../../shared/events'
import { createClaudeProvider } from './claude'
import type { ClaudeQuery, SdkUserMessage } from './claude'
import type { SessionContext } from './types'

const context: SessionContext = {
  sessionId: 'session_c',
  workspaceId: 'workspace_c',
  agentId: 'agent_c',
  title: 'Claude session',
  prompt: 'Do the task.',
  cwd: '/repo',
  model: 'claude-sonnet-5',
}

interface Recorded {
  type: EventType
  payload: EventPayloads[EventType]
}

/**
 * A stream that yields the given messages and then ENDS — the test analogue of
 * a conversation the user closed. In production the SDK stream stays open
 * awaiting input; a stream that returns is what cancel/close looks like, so
 * these fixtures end with a completed session after their last message.
 */
function streamOf(messages: unknown[], interrupt?: () => Promise<void>): ReturnType<ClaudeQuery> {
  const iterable = (async function* () {
    for (const message of messages) {
      yield message
      await Promise.resolve()
    }
  })() as ReturnType<ClaudeQuery>
  iterable.interrupt = interrupt
  return iterable
}

async function runSession(
  messages: unknown[],
): Promise<{ events: Recorded[]; queryArgs: Parameters<ClaudeQuery>[0] }> {
  let queryArgs: Parameters<ClaudeQuery>[0] | undefined
  const query: ClaudeQuery = (args) => {
    queryArgs = args
    return streamOf(messages)
  }
  const provider = createClaudeProvider(query)
  const events: Recorded[] = []

  provider.startSession(context, (type, payload) => events.push({ type, payload }))
  await vi.waitFor(() => {
    expect(events.at(-1)?.type).toBe('session.ended')
  })

  return { events, queryArgs: queryArgs as Parameters<ClaudeQuery>[0] }
}

async function firstPromptMessage(
  prompt: Parameters<ClaudeQuery>[0]['prompt'],
): Promise<SdkUserMessage> {
  const iterator = (prompt as AsyncIterable<SdkUserMessage>)[Symbol.asyncIterator]()
  const { value } = await iterator.next()
  return value as SdkUserMessage
}

const successResult = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.12,
  usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 80 },
}

describe('createClaudeProvider', () => {
  it('declares full capabilities including vision, caching, and native skills', () => {
    const provider = createClaudeProvider(() => streamOf([]))

    expect(provider.id).toBe('claude')
    expect(provider.capabilities).toMatchObject({
      vision: true,
      promptCaching: true,
      taskBudgets: true,
      nativeSkills: true,
    })
  })

  it('seeds the streaming input with the prompt and passes cwd, model, system prompt', async () => {
    const { queryArgs } = await runSession([successResult])

    const first = await firstPromptMessage(queryArgs.prompt)
    expect(first).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'Do the task.' },
    })
    expect(queryArgs.options.cwd).toBe('/repo')
    expect(queryArgs.options.model).toBe('claude-sonnet-5')
    expect(queryArgs.options.systemPrompt).toContain('Agentinator agent')
  })

  it('always wires canUseTool but allows every tool when no decider is set', async () => {
    const { queryArgs } = await runSession([successResult])

    const canUseTool = queryArgs.options.canUseTool
    expect(canUseTool).toBeDefined()
    await expect(canUseTool?.('read', { path: 'a.ts' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { path: 'a.ts' },
    })
  })

  it('maps the permission decider onto the SDK canUseTool contract', async () => {
    let queryArgs: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      queryArgs = args
      return streamOf([successResult])
    }
    const decide = vi.fn((_session: string, tool: string) => Promise.resolve(tool === 'read'))
    const provider = createClaudeProvider(query, decide)
    const events: Recorded[] = []

    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })

    const canUseTool = queryArgs?.options.canUseTool
    expect(canUseTool).toBeDefined()

    await expect(canUseTool?.('read', { path: 'a.ts' })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { path: 'a.ts' },
    })
    await expect(canUseTool?.('bash', { command: 'rm -rf /' })).resolves.toEqual({
      behavior: 'deny',
      message: 'Denied from an Agentinator approval card.',
    })
    expect(decide).toHaveBeenCalledWith('session_c', 'read', { path: 'a.ts' })
  })

  it('surfaces AskUserQuestion as an answerable question event, not a permission ask', async () => {
    let queryArgs: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      queryArgs = args
      return streamOf([successResult])
    }
    const decide = vi.fn(() => Promise.resolve(true))
    const provider = createClaudeProvider(query, decide)
    const events: Recorded[] = []

    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })

    const result = await queryArgs?.options.canUseTool?.('AskUserQuestion', {
      questions: [
        {
          question: 'Which approach?',
          options: [{ label: 'Continue' }, { label: 'Restart' }],
        },
        { question: 'Bare strings?', options: ['a', 'b'] },
      ],
    })
    expect(result).toMatchObject({ behavior: 'deny' })
    expect(decide).not.toHaveBeenCalled()

    const question = events.find((event) => event.type === 'agent.question')
    expect(question?.payload).toMatchObject({
      sessionId: 'session_c',
      questions: [
        { question: 'Which approach?', options: ['Continue', 'Restart'] },
        { question: 'Bare strings?', options: ['a', 'b'] },
      ],
    })
    expect((question?.payload as { requestId: string }).requestId).toMatch(/^approval_/)
  })

  it('defaults a malformed AskUserQuestion input to an empty question set', async () => {
    let queryArgs: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      queryArgs = args
      return streamOf([successResult])
    }
    const provider = createClaudeProvider(query)
    const events: Recorded[] = []

    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })

    // No questions field at all → an empty set rather than a throw.
    await queryArgs?.options.canUseTool?.('AskUserQuestion', {})
    // A non-record entry, a record with a non-array options field, and an
    // option record missing its label all collapse to empty defaults.
    await queryArgs?.options.canUseTool?.('AskUserQuestion', {
      questions: [
        'not-a-record',
        { options: 'not-an-array' },
        { question: 'Pick', options: [{}, { label: 'B' }] },
      ],
    })

    const questions = events.filter((event) => event.type === 'agent.question')
    expect((questions[0]?.payload as EventPayloads['agent.question']).questions).toEqual([])
    expect((questions[1]?.payload as EventPayloads['agent.question']).questions).toEqual([
      { question: '', options: [] },
      { question: '', options: [] },
      { question: 'Pick', options: ['', 'B'] },
    ])
  })

  it('emits session.started immediately with the context identity', async () => {
    const { events } = await runSession([successResult])

    expect(events[0]).toEqual({
      type: 'session.started',
      payload: {
        sessionId: 'session_c',
        agentId: 'agent_c',
        workspaceId: 'workspace_c',
        title: 'Claude session',
      },
    })
  })

  it('maps assistant text, thinking, and tool_use blocks to normalized events', async () => {
    const { events } = await runSession([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Reading the repo first.' },
            { type: 'text', text: 'On it.' },
            { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
            { type: 'unknown_block' },
            'not-a-block',
          ],
        },
      },
      successResult,
    ])

    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'agent.thinking',
      'agent.text',
      'tool.called',
      'cost.usage',
      'session.idle',
      'session.ended',
    ])
    expect(events[3]?.payload).toMatchObject({ callId: 'toolu_1', tool: 'bash' })
  })

  it('maps tool_result blocks, stringifying structured content and flagging errors', async () => {
    const { events } = await runSession([
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'plain output' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ ok: 1 }], is_error: true },
            { type: 'text', text: 'ignored' },
          ],
        },
      },
      successResult,
    ])

    const results = events.filter((event) => event.type === 'tool.resulted')
    expect(results[0]?.payload).toMatchObject({
      callId: 'toolu_1',
      ok: true,
      output: 'plain output',
    })
    expect(results[1]?.payload).toMatchObject({
      callId: 'toolu_2',
      ok: false,
      output: '[{"ok":1}]',
    })
  })

  it('maps a result to cost.usage then session.idle — the turn ends, the session lives', async () => {
    const { events } = await runSession([successResult])

    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'cost.usage',
      'session.idle',
      'session.ended',
    ])
    const cost = events.find((event) => event.type === 'cost.usage')
    expect(cost?.payload).toEqual({
      sessionId: 'session_c',
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 80,
      usd: 0.12,
    })
    const idle = events.find((event) => event.type === 'session.idle')
    expect(idle?.payload).toEqual({ sessionId: 'session_c' })
  })

  it('defaults missing usage counts to zero on the cost event', async () => {
    const { events } = await runSession([
      { type: 'result', subtype: 'error_during_execution', usage: { input_tokens: 5 } },
    ])

    const cost = events.find((event) => event.type === 'cost.usage')
    expect(cost?.payload).toMatchObject({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      usd: 0,
    })
  })

  it('tolerates malformed and unknown messages without emitting', async () => {
    const { events } = await runSession([
      'garbage',
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: 'not-a-record' },
      { type: 'user', message: { content: 'not-an-array' } },
      { type: 'result', subtype: 'success', usage: 'not-a-record' },
    ])

    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'cost.usage',
      'session.idle',
      'session.ended',
    ])
  })

  it('drives a second turn when a follow-up message is sent', async () => {
    // A conversational mock: it reads the input stream and answers each user
    // message with one assistant turn + result, staying open for the next.
    const query: ClaudeQuery = (args) => {
      const prompt = args.prompt as AsyncIterable<SdkUserMessage>
      return (async function* () {
        for await (const message of prompt) {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: `echo: ${message.message.content}` }] },
          }
          yield { ...successResult }
        }
      })() as ReturnType<ClaudeQuery>
    }
    const provider = createClaudeProvider(query)
    const events: Recorded[] = []

    const handle = provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === 'session.idle')).toHaveLength(1)
    })

    await handle.send('follow up')
    await vi.waitFor(() => {
      expect(events.filter((event) => event.type === 'session.idle')).toHaveLength(2)
    })

    const texts = events
      .filter((event) => event.type === 'agent.text')
      .map((event) => (event.payload as { text: string }).text)
    expect(texts).toEqual(['echo: Do the task.', 'echo: follow up'])

    await handle.cancel()
  })

  it('ends failed when the stream errors', async () => {
    const query: ClaudeQuery = () =>
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }
        throw new Error('stream broke')
      })() as ReturnType<ClaudeQuery>
    const provider = createClaudeProvider(query)
    const events: Recorded[] = []

    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })

    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'failed' })
  })

  it('cancel closes the input, interrupts the stream, and marks the ending cancelled', async () => {
    const interrupt = vi.fn(() => Promise.resolve())
    let releaseResult: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseResult = resolve
    })
    const query: ClaudeQuery = () => {
      const iterable = (async function* () {
        await gate
        yield { type: 'result', subtype: 'error_during_execution' }
      })() as ReturnType<ClaudeQuery>
      iterable.interrupt = interrupt
      return iterable
    }
    const provider = createClaudeProvider(query)
    const events: Recorded[] = []

    const handle = provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await handle.cancel()
    releaseResult()
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })

    expect(interrupt).toHaveBeenCalledOnce()
    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'cancelled' })
    // The late result arrived after cancel — it must not have been mapped.
    expect(events.some((event) => event.type === 'cost.usage')).toBe(false)
  })

  it('cancel is safe when the stream exposes no interrupt', async () => {
    const query: ClaudeQuery = () => streamOf([successResult])
    const provider = createClaudeProvider(query)
    const events: Recorded[] = []

    const handle = provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await handle.cancel()
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })
  })
})
