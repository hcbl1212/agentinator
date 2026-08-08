import { describe, expect, it, vi } from 'vitest'

import type { EventPayloads, EventType } from '../../shared/events'
import { createClaudeProvider } from './claude'
import type { ClaudeQuery } from './claude'
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

  it('passes prompt, cwd, model, and a stable system prompt to the SDK', async () => {
    const { queryArgs } = await runSession([successResult])

    expect(queryArgs.prompt).toBe('Do the task.')
    expect(queryArgs.options.cwd).toBe('/repo')
    expect(queryArgs.options.model).toBe('claude-sonnet-5')
    expect(queryArgs.options.systemPrompt).toContain('Agentinator agent')
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

  it('maps the result message to cost.usage and a completed ending', async () => {
    const { events } = await runSession([successResult])

    expect(events.at(-2)).toEqual({
      type: 'cost.usage',
      payload: {
        sessionId: 'session_c',
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 80,
        usd: 0.12,
      },
    })
    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'completed' })
  })

  it('treats a non-success result with partial usage as failed, defaulting counts to zero', async () => {
    const { events } = await runSession([
      { type: 'result', subtype: 'error_during_execution', usage: { input_tokens: 5 } },
    ])

    expect(events.at(-2)?.payload).toMatchObject({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      usd: 0,
    })
    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'failed' })
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
      'session.ended',
    ])
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

  it('ends failed when the stream finishes without a result message', async () => {
    const { events } = await runSession([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
    ])

    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'failed' })
  })

  it('cancel interrupts the SDK stream and marks the ending cancelled', async () => {
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
  })

  it('ends cancelled when the interrupted stream closes without a result', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const query: ClaudeQuery = () =>
      (async function* () {
        await gate
        // An interrupt can close the stream with no result message at all.
        yield* []
      })() as ReturnType<ClaudeQuery>
    const provider = createClaudeProvider(query)
    const events: Recorded[] = []

    const handle = provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await handle.cancel()
    release()
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe('session.ended')
    })

    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'cancelled' })
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

  it('rejects steering for now', async () => {
    const provider = createClaudeProvider(() => streamOf([successResult]))
    const handle = provider.startSession(context, () => undefined)

    await expect(handle.send('new direction')).rejects.toThrow(/not supported yet/)
  })
})
