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
