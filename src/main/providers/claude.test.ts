import { describe, expect, it, vi } from 'vitest'

import type { ConsoleEntry, EventPayloads, EventType, NetworkEntry } from '../../shared/events'
import type { GitRunner } from '../git'
import { missingContractEvents } from './contract'
import { createClaudeProvider } from './claude'
import type { ClaudeQuery, PreviewVision, SdkUserMessage } from './claude'
import type { PermissionDecider, SessionContext } from './types'

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
  const next = await iterator.next()
  return next.value as SdkUserMessage
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

  it('blocks editing and command tools for a read-only planning stage', async () => {
    let queryArgs: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      queryArgs = args
      return streamOf([successResult])
    }
    // A decider that would allow everything — the read-only gate must still deny.
    const decide = vi.fn(() => Promise.resolve(true))
    const provider = createClaudeProvider(query, decide)

    provider.startSession({ ...context, readOnly: true }, () => undefined)
    await vi.waitFor(() => {
      expect(queryArgs?.options.canUseTool).toBeDefined()
    })
    const canUseTool = queryArgs?.options.canUseTool

    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'bash']) {
      const result = await canUseTool?.(tool, {})
      expect(result).toMatchObject({ behavior: 'deny' })
      expect((result as { message: string }).message).toContain('read-only planning stage')
    }
    // Reading/searching still flows through the decider (allowed here), and the
    // deny short-circuits before the decider is ever consulted for an edit.
    await expect(canUseTool?.('Read', { path: 'a.ts' })).resolves.toMatchObject({
      behavior: 'allow',
    })
    expect(decide).not.toHaveBeenCalledWith('session_c', 'Edit', {})
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
            { type: 'tool_result', tool_use_id: 'toolu_3', content: { done: true } },
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
    // Non-array structured content stringifies whole.
    expect(results[2]?.payload).toMatchObject({ callId: 'toolu_3', output: '{"done":true}' })
  })

  it('redacts base64 image tool results so screenshots never bloat the log', async () => {
    const { events } = await runSession([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_shot',
              content: [
                { type: 'image', source: { data: 'AAAABBBBCCCCDDDD' } },
                { type: 'text', text: 'the app' },
              ],
            },
          ],
        },
      },
      successResult,
    ])

    const result = events.find((event) => event.type === 'tool.resulted')
    const output = (result?.payload as EventPayloads['tool.resulted']).output
    expect(output).toContain('[screenshot]')
    expect(output).toContain('the app')
    expect(output).not.toContain('AAAABBBBCCCCDDDD')
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

  it('forces a metered API key into the subprocess env when context.apiKey is set', async () => {
    let queryArgs: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      queryArgs = args
      return streamOf([successResult])
    }
    const provider = createClaudeProvider(query)
    const events: Recorded[] = []
    provider.startSession({ ...context, apiKey: 'sk-test-123' }, (type, payload) =>
      events.push({ type, payload }),
    )

    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })
    expect(queryArgs?.options.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-test-123' })
  })

  it('captures the credential source from the init message once', async () => {
    const { events } = await runSession([
      { type: 'system', subtype: 'init', apiKeySource: 'user' },
      { type: 'system', subtype: 'init', apiKeySource: 'none' }, // ignored (once)
    ])

    const auth = events.filter((event) => event.type === 'session.auth')
    expect(auth).toHaveLength(1)
    expect(auth[0]?.payload).toEqual({ sessionId: 'session_c', source: 'user' })
  })

  it('maps a rate-limit event to a normalized account.limit', async () => {
    const { events } = await runSession([
      {
        type: 'rate_limit_event',
        session_id: 's',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: 1_700_000_000,
          overageStatus: 'allowed',
        },
      },
    ])

    const limit = events.find((event) => event.type === 'account.limit')
    expect(limit?.payload).toMatchObject({
      sessionId: 'session_c',
      status: 'rejected',
      window: 'five_hour',
      overageAvailable: true,
    })
  })

  it('samples account usage after a turn and emits it normalized', async () => {
    const rawUsage = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 11, resets_at: '2026-08-09T15:30:00Z' } },
      session: { total_cost_usd: 0.5 },
    }
    const query: ClaudeQuery = () => {
      const stream = streamOf([successResult])
      ;(
        stream as unknown as {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise<unknown>
        }
      ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = () => Promise.resolve(rawUsage)
      return stream
    }
    const provider = createClaudeProvider(query)
    const events: Recorded[] = []
    provider.startSession(context, (type, payload) => events.push({ type, payload }))

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'account.usage')).toBe(true)
    })
    const usage = events.find((event) => event.type === 'account.usage')
    expect(usage?.payload).toMatchObject({
      sessionId: 'session_c',
      mode: 'subscription',
      plan: 'max',
    })
  })

  it('bills only the per-turn delta of the SDK’s running cost total', async () => {
    const { events } = await runSession([
      { type: 'result', total_cost_usd: 0.12, usage: { input_tokens: 100, output_tokens: 40 } },
      { type: 'result', total_cost_usd: 0.2, usage: { input_tokens: 2, output_tokens: 46 } },
      // A zeroed crash result must not bill a negative amount.
      { type: 'result', subtype: 'error', total_cost_usd: 0, usage: {} },
    ])

    const costs = events
      .filter((event) => event.type === 'cost.usage')
      .map((event) => (event.payload as { usd: number }).usd)
    expect(costs).toHaveLength(3)
    expect(costs[0]).toBeCloseTo(0.12)
    expect(costs[1]).toBeCloseTo(0.08)
    expect(costs[2]).toBe(0)
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
          const content = message.message.content
          yield {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: `echo: ${typeof content === 'string' ? content : ''}` },
              ],
            },
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

  it('sends attached images as base64 content blocks, text stays a plain string', async () => {
    const seen: unknown[] = []
    const query: ClaudeQuery = (args) => {
      const prompt = args.prompt as AsyncIterable<SdkUserMessage>
      return (async function* () {
        for await (const message of prompt) {
          seen.push(message.message.content)
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

    await handle.send('look at this', [{ mediaType: 'image/png', data: 'AQID' }])
    await vi.waitFor(() => {
      expect(seen).toHaveLength(2)
    })

    // The opening message had no images → a plain string (cache-friendly).
    expect(seen[0]).toBe('Do the task.')
    // The follow-up carries a text block plus an image block.
    expect(seen[1]).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
    ])

    await handle.cancel()
  })

  it('captures the SDK session id once as a resume token', async () => {
    const { events } = await runSession([
      { type: 'system', subtype: 'init', session_id: 'sdk-xyz' },
      { type: 'system', subtype: 'noise', session_id: 'sdk-xyz' },
      successResult,
    ])

    const resumable = events.filter((event) => event.type === 'session.resumable')
    expect(resumable).toHaveLength(1)
    expect(resumable[0]?.payload).toEqual({ sessionId: 'session_c', resumeToken: 'sdk-xyz' })
  })

  it('captures the running model once from the assistant stream', async () => {
    const { events } = await runSession([
      {
        type: 'assistant',
        message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'a' }] },
      },
      {
        type: 'assistant',
        message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'b' }] },
      },
      successResult,
    ])

    const models = events.filter((event) => event.type === 'session.model')
    expect(models).toHaveLength(1)
    expect(models[0]?.payload).toEqual({ sessionId: 'session_c', model: 'claude-opus-4-8' })
  })

  it('resumes with a token and skips the opening prompt, sending the reply instead', async () => {
    let queryArgs: Parameters<ClaudeQuery>[0] | undefined
    const seen: unknown[] = []
    const query: ClaudeQuery = (args) => {
      queryArgs = args
      const prompt = args.prompt as AsyncIterable<SdkUserMessage>
      return (async function* () {
        for await (const message of prompt) {
          seen.push(message.message.content)
          yield { ...successResult }
        }
      })() as ReturnType<ClaudeQuery>
    }
    const provider = createClaudeProvider(query)

    const handle = provider.startSession(
      { ...context, resume: { token: 'sdk-abc', turns: [{ role: 'user', text: 'hi' }] } },
      () => undefined,
    )
    await handle.send('the reply')
    await vi.waitFor(() => {
      expect(seen).toContain('the reply')
    })

    expect(queryArgs?.options.resume).toBe('sdk-abc')
    // The opening task prompt was skipped — the first input is the reply.
    expect(seen[0]).toBe('the reply')

    await handle.cancel()
  })

  it('ends failed when the stream errors', async () => {
    const query: ClaudeQuery = () =>
      (async function* () {
        await Promise.resolve()
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

describe('createClaudeProvider — parity contract', () => {
  it('emits every event the UI renders a session from', async () => {
    const stream = [
      { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 'sdk-1' },
      {
        type: 'assistant',
        message: {
          model: 'claude-x',
          content: [
            { type: 'thinking', thinking: 'planning' },
            { type: 'text', text: 'working' },
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
      successResult,
    ]
    const git: GitRunner = vi.fn((args: string[]) =>
      Promise.resolve(
        args[0] === 'diff' && args[1] === 'HEAD'
          ? 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y'
          : '',
      ),
    )
    let queryArgs: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      queryArgs = args
      return streamOf(stream)
    }
    const provider = createClaudeProvider(
      query,
      vi.fn(() => Promise.resolve(true)),
      undefined,
      git,
    )
    const events: Recorded[] = []

    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    // agent.question is routed through canUseTool, not the stream.
    await vi.waitFor(() => {
      expect(queryArgs?.options.canUseTool).toBeDefined()
    })
    await queryArgs?.options.canUseTool?.('AskUserQuestion', {
      questions: [{ question: 'q', options: ['a'] }],
    })

    await vi.waitFor(() => {
      expect(missingContractEvents(events.map((event) => event.type))).toEqual([])
    })
  })
})

describe('createClaudeProvider — workspace diff', () => {
  async function runWithGit(git: GitRunner | undefined): Promise<Recorded[]> {
    const query: ClaudeQuery = () => streamOf([successResult])
    const provider = createClaudeProvider(query, undefined, undefined, git)
    const events: Recorded[] = []
    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    // A diff can land just after session.ended, so wait for it to EXIST rather
    // than be the last event.
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'session.ended')).toBe(true)
    })
    return events
  }

  it('emits file.diffed for the agent’s edits after a turn', async () => {
    const git: GitRunner = vi.fn((args: string[]) =>
      Promise.resolve(
        args[0] === 'diff' && args[1] === 'HEAD'
          ? 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new'
          : '', // ls-files → nothing untracked
      ),
    )

    // The diff is reported asynchronously after the turn — it can land just
    // after session.ended, so wait for it specifically.
    const events = await runWithGit(git)
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'file.diffed')).toBe(true)
    })

    const diffs = events.filter((event) => event.type === 'file.diffed')
    expect(diffs).toHaveLength(1)
    expect(diffs[0]?.payload).toMatchObject({
      sessionId: 'session_c',
      path: 'x.ts',
      additions: 1,
      deletions: 1,
    })
  })

  it('emits no diffs when no git runner is wired', async () => {
    const events = await runWithGit(undefined)

    expect(events.some((event) => event.type === 'file.diffed')).toBe(false)
  })

  it('completes the session even when git fails entirely', async () => {
    const git: GitRunner = vi.fn(() => Promise.reject(new Error('git blew up')))

    const events = await runWithGit(git)

    expect(events.at(-1)?.type).toBe('session.ended')
    expect(events.some((event) => event.type === 'file.diffed')).toBe(false)
  })
})

describe('createClaudeProvider — preview vision', () => {
  function visionStub(
    consoleEntries: ConsoleEntry[] = [{ level: 'warning', text: 'hydration mismatch' }],
    networkEntries: NetworkEntry[] = [],
  ): {
    vision: PreviewVision
    capture: ReturnType<typeof vi.fn>
    tool: ReturnType<typeof vi.fn>
    createSdkMcpServer: ReturnType<typeof vi.fn>
  } {
    const capture = vi.fn(() =>
      Promise.resolve({
        base64: 'YmFzZTY0',
        mediaType: 'image/png',
        console: consoleEntries,
        network: networkEntries,
      }),
    )
    const tool = vi.fn(
      (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
        name,
        description,
        inputSchema,
        handler,
      }),
    )
    const createSdkMcpServer = vi.fn((config: unknown) => ({ config }))
    return {
      capture,
      tool,
      createSdkMcpServer,
      vision: { capture, tool, createSdkMcpServer },
    }
  }

  async function runVisionSession(
    messages: unknown[],
    decide?: PermissionDecider,
    consoleEntries?: ConsoleEntry[],
    networkEntries?: NetworkEntry[],
  ): Promise<{
    events: Recorded[]
    queryArgs: Parameters<ClaudeQuery>[0]
    stub: ReturnType<typeof visionStub>
  }> {
    const stub = visionStub(consoleEntries, networkEntries)
    let queryArgs: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      queryArgs = args
      return streamOf(messages)
    }
    const provider = createClaudeProvider(query, decide, stub.vision)
    const events: Recorded[] = []
    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })
    return { events, queryArgs: queryArgs as Parameters<ClaudeQuery>[0], stub }
  }

  it('exposes the app-capture tool as an in-process MCP server', async () => {
    const { queryArgs, stub } = await runVisionSession([successResult])

    expect(stub.tool).toHaveBeenCalledWith(
      'capture_app',
      expect.stringContaining('screenshot'),
      {},
      expect.any(Function),
    )
    expect(stub.createSdkMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'preview', version: '1.0.0' }),
    )
    expect(queryArgs.options.mcpServers).toHaveProperty('preview')
  })

  it('the tool handler captures for the session and returns console text + an image', async () => {
    const { stub } = await runVisionSession([successResult])

    const handler = stub.tool.mock.calls[0]?.[3] as () => Promise<{
      content: Array<Record<string, unknown>>
    }>
    const result = await handler()

    expect(stub.capture).toHaveBeenCalledWith('session_c')
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Console output from the app:\n[warning] hydration mismatch' },
        { type: 'image', data: 'YmFzZTY0', mimeType: 'image/png' },
      ],
    })
  })

  it('returns just the image when the app logged nothing', async () => {
    const { stub } = await runVisionSession([successResult], undefined, [])

    const handler = stub.tool.mock.calls[0]?.[3] as () => Promise<{
      content: Array<Record<string, unknown>>
    }>
    const result = await handler()

    expect(result).toEqual({
      content: [{ type: 'image', data: 'YmFzZTY0', mimeType: 'image/png' }],
    })
  })

  it('summarizes network activity and spells out the failing calls', async () => {
    const { stub } = await runVisionSession(
      [successResult],
      undefined,
      [],
      [
        { method: 'GET', url: 'http://localhost:3001/', status: 200, ok: true },
        { method: 'GET', url: 'http://localhost:4001/api/cart', status: 500, ok: false },
      ],
    )

    const handler = stub.tool.mock.calls[0]?.[3] as () => Promise<{
      content: Array<{ type: string; text?: string }>
    }>
    const result = await handler()

    const text = result.content.find((block) => block.type === 'text')?.text
    expect(text).toBe('Network: 2 request(s), 1 failed.\nGET http://localhost:4001/api/cart → 500')
  })

  it('reports a clean network run without listing calls', async () => {
    const { stub } = await runVisionSession(
      [successResult],
      undefined,
      [],
      [{ method: 'GET', url: 'http://localhost:3001/', status: 200, ok: true }],
    )

    const handler = stub.tool.mock.calls[0]?.[3] as () => Promise<{
      content: Array<{ type: string; text?: string }>
    }>
    const result = await handler()

    const text = result.content.find((block) => block.type === 'text')?.text
    expect(text).toBe('Network: 1 request(s), 0 failed.')
  })

  it('auto-allows the capture tool without ever consulting the approval decider', async () => {
    const decide = vi.fn(() => Promise.resolve(false))
    const { queryArgs } = await runVisionSession([successResult], decide)

    const decision = await queryArgs.options.canUseTool?.('mcp__preview__capture_app', {})

    expect(decision).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(decide).not.toHaveBeenCalled()
  })

  it('omits the preview tool when no vision is wired', async () => {
    const { queryArgs } = await runSession([successResult])

    expect(queryArgs.options.mcpServers).toBeUndefined()
  })
})
