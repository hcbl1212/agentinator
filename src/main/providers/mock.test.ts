import { describe, expect, it, vi } from 'vitest'

import type { EventType } from '../../shared/events'
import { createMockProvider } from './mock'
import type { SessionContext } from './types'

const context: SessionContext = {
  sessionId: 'session_demo',
  workspaceId: 'workspace_demo',
  agentId: 'agent_demo',
  title: 'Demo session',
  prompt: 'Add a greet util.',
  cwd: '/tmp',
}

const immediate = (): Promise<void> => Promise.resolve()

async function settle(): Promise<void> {
  // Drain the microtask chain the mock's run loop advances through.
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve()
  }
}

describe('createMockProvider', () => {
  it('declares tool-use and streaming capabilities, no vision', () => {
    const provider = createMockProvider(immediate)

    expect(provider.id).toBe('mock')
    expect(provider.capabilities).toMatchObject({ toolUse: true, streaming: true, vision: false })
  })

  it('emits the full scripted session, ending in completion', async () => {
    const provider = createMockProvider(immediate)
    const events: EventType[] = []

    provider.startSession(context, (type) => events.push(type))
    await settle()

    expect(events[0]).toBe('session.started')
    expect(events.at(-1)).toBe('session.ended')
    expect(events).toContain('agent.thinking')
    expect(events).toContain('agent.text')
    expect(events).toContain('tool.called')
    expect(events).toContain('tool.resulted')
    expect(events).toContain('file.diffed')
    expect(events).toContain('cost.usage')
  })

  it('tags every event with the session id from context', async () => {
    const provider = createMockProvider(immediate)
    const payloads: unknown[] = []

    provider.startSession(context, (_type, payload) => payloads.push(payload))
    await settle()

    expect(payloads.length).toBeGreaterThan(0)
    for (const payload of payloads) {
      expect((payload as { sessionId?: string }).sessionId).toBe('session_demo')
    }
  })

  it('ends with a cancelled outcome when cancelled mid-run', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sleep = vi.fn((): Promise<void> => gate)
    const provider = createMockProvider(sleep)
    const events: Array<{ type: EventType; payload: unknown }> = []

    const handle = provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await handle.cancel()
    release()
    await settle()

    const last = events.at(-1)
    expect(last?.type).toBe('session.ended')
    expect(last?.payload).toMatchObject({ outcome: 'cancelled' })
  })

  it('rejects steering — the mock is a scripted session', async () => {
    const provider = createMockProvider(immediate)
    const handle = provider.startSession(context, () => undefined)

    await expect(handle.send('change course')).rejects.toThrow(/does not support steering/)
    await settle()
  })

  it('ends cancelled when cancellation lands after the last step', async () => {
    let sleepCalls = 0
    let release: () => void = () => undefined
    const finalGate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Let the 8 scripted steps run; hold only the final pre-ended sleep open.
    const sleep = vi.fn((): Promise<void> => {
      sleepCalls += 1
      return sleepCalls === 9 ? finalGate : Promise.resolve()
    })
    const provider = createMockProvider(sleep)
    const events: Array<{ type: EventType; payload: unknown }> = []

    const handle = provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await settle()
    expect(events.at(-1)?.type).toBe('cost.usage')

    await handle.cancel()
    release()
    await settle()

    expect(events.at(-1)?.type).toBe('session.ended')
    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'cancelled' })
  })

  it('asks permission for the write and the test run, in that order', async () => {
    const decisions: Array<{ tool: string; input: unknown }> = []
    const decide = vi.fn((_session: string, tool: string, input: unknown) => {
      decisions.push({ tool, input })
      return Promise.resolve(true)
    })
    const provider = createMockProvider(immediate, 0, decide)

    provider.startSession(context, () => undefined)
    await settle()

    expect(decisions).toEqual([
      { tool: 'write', input: { path: 'src/demo/greet.ts' } },
      { tool: 'bash', input: { command: 'npm test' } },
    ])
    expect(decide).toHaveBeenCalledWith('session_demo', 'write', expect.anything())
  })

  it('skips the change when the write is denied, but still completes', async () => {
    const decide = vi.fn((_session: string, tool: string) => Promise.resolve(tool !== 'write'))
    const provider = createMockProvider(immediate, 0, decide)
    const events: Array<{ type: EventType; payload: unknown }> = []

    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await settle()

    const types = events.map((event) => event.type)
    expect(types).not.toContain('file.diffed')
    expect(
      events.some(
        (event) =>
          event.type === 'agent.text' &&
          (event.payload as { text: string }).text.includes('Write denied'),
      ),
    ).toBe(true)
    expect(types.filter((type) => type === 'tool.called')).toHaveLength(1)
    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'completed' })
  })

  it('reports a denial for the test run too', async () => {
    const decide = vi.fn((_session: string, tool: string) => Promise.resolve(tool !== 'bash'))
    const provider = createMockProvider(immediate, 0, decide)
    const events: Array<{ type: EventType; payload: unknown }> = []

    provider.startSession(context, (type, payload) => events.push({ type, payload }))
    await settle()

    expect(
      events.some(
        (event) =>
          event.type === 'agent.text' &&
          (event.payload as { text: string }).text.includes('Test run denied'),
      ),
    ).toBe(true)
    expect(events.at(-1)?.payload).toMatchObject({ outcome: 'completed' })
  })

  it('bails out cancelled at each pre-decide checkpoint', async () => {
    // The script checks `cancelled` right before each decide() call. Drive a
    // sleep that cancels the session on its Nth call to hit both checkpoints.
    for (const cancelOnCall of [3, 6]) {
      let calls = 0
      const ref: { handle?: { cancel: () => Promise<void> } } = {}
      const sleep = vi.fn((): Promise<void> => {
        calls += 1
        if (calls === cancelOnCall) {
          void ref.handle?.cancel()
        }
        return Promise.resolve()
      })
      const decide = vi.fn(() => Promise.resolve(true))
      const provider = createMockProvider(sleep, 0, decide)
      const events: Array<{ type: EventType; payload: unknown }> = []

      ref.handle = provider.startSession(context, (type, payload) => events.push({ type, payload }))
      await settle()

      expect(events.at(-1)?.type).toBe('session.ended')
      expect(events.at(-1)?.payload).toMatchObject({ outcome: 'cancelled' })
    }
  })

  it('paces the script with real timer delays by default', async () => {
    vi.useFakeTimers()
    try {
      const provider = createMockProvider(undefined, 5)
      const events: EventType[] = []

      provider.startSession(context, (type) => events.push(type))
      await vi.advanceTimersByTimeAsync(100)

      expect(events.at(-1)).toBe('session.ended')
    } finally {
      vi.useRealTimers()
    }
  })
})
