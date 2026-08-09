import { describe, expect, it, vi } from 'vitest'

import type { StoredEvent } from '../shared/events'
import { EventStore } from './eventStore'
import { createMockProvider } from './providers/mock'
import { SessionManager } from './sessions'
import type { AgentProvider } from './providers/types'

function instantProvider(id: string): AgentProvider {
  return {
    id,
    label: id,
    capabilities: {
      vision: false,
      toolUse: false,
      streaming: false,
      promptCaching: false,
      taskBudgets: false,
      batchApi: false,
      nativeSkills: false,
      contextWindowTokens: 1,
    },
    startSession(context, emit) {
      emit('session.started', {
        sessionId: context.sessionId,
        agentId: context.agentId,
        workspaceId: context.workspaceId,
        title: context.title,
      })
      return {
        send: () => Promise.resolve(),
        cancel: () => {
          emit('session.ended', { sessionId: context.sessionId, outcome: 'cancelled' })
          return Promise.resolve()
        },
      }
    },
  }
}

function failsInstantlyProvider(id: string): AgentProvider {
  return {
    ...instantProvider(id),
    id,
    startSession(context, emit) {
      emit('session.ended', { sessionId: context.sessionId, outcome: 'failed' })
      return { send: () => Promise.resolve(), cancel: () => Promise.resolve() }
    },
  }
}

describe('SessionManager', () => {
  it('registers providers and lists their ids', () => {
    const manager = new SessionManager(new EventStore())
    manager.register(instantProvider('a'))
    manager.register(instantProvider('b'))

    expect(manager.providerIds()).toEqual(['a', 'b'])
  })

  it('rejects starts for unknown providers', () => {
    const manager = new SessionManager(new EventStore())

    expect(() =>
      manager.start({ providerId: 'nope', title: 't', prompt: 'p', cwd: '/tmp' }),
    ).toThrow('Unknown provider: nope')
  })

  it('appends provider events to the store and forwards them to onEvent', () => {
    const store = new EventStore()
    const forwarded: StoredEvent[] = []
    const manager = new SessionManager(store, (event) => forwarded.push(event))
    manager.register(instantProvider('a'))

    const sessionId = manager.start({ providerId: 'a', title: 'T', prompt: 'P', cwd: '/tmp' })

    expect(store.count()).toBe(2)
    expect(store.list()[0]?.type).toBe('session.started')
    expect(store.list()[0]?.payload).toMatchObject({ sessionId, title: 'T' })
    // The opening prompt is logged right after the session starts.
    expect(forwarded.map((event) => event.type)).toEqual(['session.started', 'user.message'])
  })

  it('generates workspace and agent ids when not supplied, and honors them when given', () => {
    const store = new EventStore()
    const manager = new SessionManager(store)
    manager.register(instantProvider('a'))

    manager.start({ providerId: 'a', title: 'T', prompt: 'P', cwd: '/tmp' })
    manager.start({
      providerId: 'a',
      title: 'T2',
      prompt: 'P',
      cwd: '/tmp',
      workspaceId: 'workspace_fixed',
      agentId: 'agent_fixed',
    })

    const [generated, fixed] = store.list().filter((event) => event.type === 'session.started')
    expect(generated?.payload).toMatchObject({
      workspaceId: expect.stringMatching(/^workspace_/) as unknown,
      agentId: expect.stringMatching(/^agent_/) as unknown,
    })
    expect(fixed?.payload).toMatchObject({
      workspaceId: 'workspace_fixed',
      agentId: 'agent_fixed',
    })
  })

  it('tracks active sessions and removes them when they end', async () => {
    const manager = new SessionManager(new EventStore())
    manager.register(instantProvider('a'))

    const sessionId = manager.start({ providerId: 'a', title: 'T', prompt: 'P', cwd: '/tmp' })
    expect(manager.activeCount()).toBe(1)

    await manager.cancel(sessionId)
    expect(manager.activeCount()).toBe(0)
  })

  it('does not retain a handle for a session that ended before start returned', () => {
    const manager = new SessionManager(new EventStore())
    manager.register(failsInstantlyProvider('boom'))

    manager.start({ providerId: 'boom', title: 'T', prompt: 'P', cwd: '/tmp' })

    expect(manager.activeCount()).toBe(0)
  })

  it('describes a registered provider and returns undefined for an unknown one', () => {
    const manager = new SessionManager(new EventStore())
    manager.register(instantProvider('claude'))

    expect(manager.describeProvider('claude')).toEqual({ providerId: 'claude', label: 'claude' })
    expect(manager.describeProvider('nope')).toBeUndefined()
  })

  it('cancelling an unknown session is a no-op', async () => {
    const manager = new SessionManager(new EventStore())

    await expect(manager.cancel('session_missing')).resolves.toBeUndefined()
  })

  function recordingProvider(id: string): {
    provider: AgentProvider
    send: ReturnType<typeof vi.fn>
    context: () => Parameters<AgentProvider['startSession']>[0] | undefined
  } {
    let captured: Parameters<AgentProvider['startSession']>[0] | undefined
    const send = vi.fn(() => Promise.resolve())
    return {
      send,
      context: () => captured,
      provider: {
        ...instantProvider(id),
        id,
        startSession(context, emit) {
          captured = context
          emit('session.started', {
            sessionId: context.sessionId,
            agentId: context.agentId,
            workspaceId: context.workspaceId,
            title: context.title,
          })
          return { send, cancel: () => Promise.resolve() }
        },
      },
    }
  }

  function seedConversation(store: EventStore, providerId?: string): void {
    store.append('session.started', {
      sessionId: 's1',
      agentId: 'ag',
      workspaceId: 'ws',
      title: 'T',
      providerId,
    })
    store.append('user.message', { sessionId: 's1', text: 'first' })
    store.append('agent.text', { sessionId: 's1', text: 'answer' })
  }

  it('reopens a dead session via the provider, replaying its turns and token', async () => {
    const store = new EventStore()
    seedConversation(store, 'claude')
    store.append('session.resumable', { sessionId: 's1', resumeToken: 'sdk-123' })
    store.append('session.idle', { sessionId: 's1' })

    const rec = recordingProvider('claude')
    const events: StoredEvent[] = []
    const manager = new SessionManager(store, (event) => events.push(event))
    manager.register(rec.provider)

    // No live handle for s1 (fresh process) → send reopens it.
    await manager.send('s1', 'continue please')

    expect(rec.context()?.resume).toEqual({
      token: 'sdk-123',
      turns: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'answer' },
      ],
    })
    expect(rec.send).toHaveBeenCalledWith('continue please', undefined)
    expect(events.some((event) => event.type === 'session.resumed')).toBe(true)
    expect(events.filter((event) => event.type === 'user.message').at(-1)?.payload).toMatchObject({
      sessionId: 's1',
      text: 'continue please',
    })
    expect(manager.activeCount()).toBe(1)
  })

  it('does not resume a session with no provider id or an unregistered provider', async () => {
    const noProvider = new EventStore()
    seedConversation(noProvider)
    const eventsA: StoredEvent[] = []
    const managerA = new SessionManager(noProvider, (event) => eventsA.push(event))
    await managerA.send('s1', 'hi')
    expect(eventsA.some((event) => event.type === 'user.message')).toBe(false)

    const goneProvider = new EventStore()
    seedConversation(goneProvider, 'gone')
    const eventsB: StoredEvent[] = []
    const managerB = new SessionManager(goneProvider, (event) => eventsB.push(event))
    await managerB.send('s1', 'hi')
    expect(eventsB.some((event) => event.type === 'user.message')).toBe(false)
  })

  it('gives up if the provider ends the session instantly on resume', async () => {
    const store = new EventStore()
    seedConversation(store, 'boom')
    const events: StoredEvent[] = []
    const manager = new SessionManager(store, (event) => events.push(event))
    manager.register(failsInstantlyProvider('boom'))

    await manager.send('s1', 'hi')

    expect(manager.activeCount()).toBe(0)
    expect(events.some((event) => event.type === 'user.message')).toBe(false)
  })

  it('forwards a follow-up message to the session handle and logs a user.message', async () => {
    const send = vi.fn(() => Promise.resolve())
    const provider: AgentProvider = {
      ...instantProvider('chatty'),
      id: 'chatty',
      startSession(context, emit) {
        emit('session.started', {
          sessionId: context.sessionId,
          agentId: context.agentId,
          workspaceId: context.workspaceId,
          title: context.title,
        })
        return { send, cancel: () => Promise.resolve() }
      },
    }
    const store = new EventStore()
    const events: StoredEvent[] = []
    const manager = new SessionManager(store, (event) => events.push(event))
    manager.register(provider)

    const sessionId = manager.start({ providerId: 'chatty', title: 'T', prompt: 'P', cwd: '/tmp' })
    await manager.send(sessionId, 'keep going')

    expect(send).toHaveBeenCalledWith('keep going', undefined)
    // The opening prompt is logged first, then the reply.
    const messages = events.filter((event) => event.type === 'user.message')
    expect(messages.map((event) => (event.payload as { text: string }).text)).toEqual([
      'P',
      'keep going',
    ])
    expect(messages.at(-1)?.payload).toEqual({ sessionId, text: 'keep going' })
  })

  it('logs the opening prompt with its attached image count', () => {
    const store = new EventStore()
    const events: StoredEvent[] = []
    const manager = new SessionManager(store, (event) => events.push(event))
    manager.register(instantProvider('a'))

    const sessionId = manager.start({
      providerId: 'a',
      title: 'T',
      prompt: 'do X',
      cwd: '/tmp',
      images: [{ mediaType: 'image/png', data: 'AAA' }],
    })

    const message = events.find((event) => event.type === 'user.message')
    expect(message?.payload).toEqual({ sessionId, text: 'do X', imageCount: 1 })
  })

  it('forwards attached images and records their count on the message', async () => {
    const send = vi.fn(() => Promise.resolve())
    const provider: AgentProvider = {
      ...instantProvider('chatty'),
      id: 'chatty',
      startSession(context, emit) {
        emit('session.started', {
          sessionId: context.sessionId,
          agentId: context.agentId,
          workspaceId: context.workspaceId,
          title: context.title,
        })
        return { send, cancel: () => Promise.resolve() }
      },
    }
    const store = new EventStore()
    const events: StoredEvent[] = []
    const manager = new SessionManager(store, (event) => events.push(event))
    manager.register(provider)

    const sessionId = manager.start({ providerId: 'chatty', title: 'T', prompt: 'P', cwd: '/tmp' })
    const shots = [{ mediaType: 'image/png', data: 'AAA' }]
    await manager.send(sessionId, 'look at this', shots)

    expect(send).toHaveBeenCalledWith('look at this', shots)
    // The opening prompt logs first (no images), then the image-bearing reply.
    const message = events.filter((event) => event.type === 'user.message').at(-1)
    expect(message?.payload).toEqual({ sessionId, text: 'look at this', imageCount: 1 })
  })

  it('sending to an unknown session is a no-op', async () => {
    const store = new EventStore()
    const events: StoredEvent[] = []
    const manager = new SessionManager(store, (event) => events.push(event))

    await expect(manager.send('session_missing', 'hi')).resolves.toBeUndefined()
    expect(events.some((event) => event.type === 'user.message')).toBe(false)
  })

  it('uses the default no-op onEvent when none is provided', () => {
    const manager = new SessionManager(new EventStore())
    manager.register(instantProvider('a'))

    expect(() =>
      manager.start({ providerId: 'a', title: 'T', prompt: 'P', cwd: '/tmp' }),
    ).not.toThrow()
  })

  function costProvider(id: string, cancel = vi.fn(() => Promise.resolve())) {
    let emitCost: (usd: number) => void = () => undefined
    const provider = {
      ...instantProvider(id),
      id,
      startSession(context: Parameters<AgentProvider['startSession']>[0], emit: never) {
        const emitFn = emit as unknown as (type: string, payload: unknown) => void
        emitFn('session.started', {
          sessionId: context.sessionId,
          agentId: context.agentId,
          workspaceId: context.workspaceId,
          title: context.title,
        })
        emitCost = (usd) =>
          emitFn('cost.usage', {
            sessionId: context.sessionId,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            usd,
          })
        return { send: () => Promise.resolve(), cancel }
      },
    } as unknown as AgentProvider
    return { provider, cost: (usd: number) => emitCost(usd) }
  }

  const onlySession = (usd: number | null) => (): import('../shared/budget').Budgets => ({
    session: usd,
    hour: null,
    day: null,
    week: null,
    month: null,
  })

  it('stops a session that exceeds its session cap and audits the breach', () => {
    const store = new EventStore()
    const types: string[] = []
    const cancel = vi.fn(() => Promise.resolve())
    const manager = new SessionManager(store, (event) => types.push(event.type), {
      getBudgets: onlySession(5),
    })
    const { provider, cost } = costProvider('spender', cancel)
    manager.register(provider)

    manager.start({ providerId: 'spender', title: 'T', prompt: 'P', cwd: '/tmp' })

    cost(3)
    expect(types).not.toContain('budget.exceeded')
    expect(cancel).not.toHaveBeenCalled()

    cost(3)
    expect(types).toContain('budget.exceeded')
    expect(cancel).toHaveBeenCalledOnce()
    const breach = store.list().find((event) => event.type === 'budget.exceeded')
    expect(breach?.payload).toMatchObject({ scope: 'session', usedUsd: 6, capUsd: 5 })
  })

  it('stops a session that pushes a daily window over its cap', () => {
    const store = new EventStore()
    const types: string[] = []
    const manager = new SessionManager(store, (event) => types.push(event.type), {
      getBudgets: () => ({ session: null, hour: null, day: 1, week: null, month: null }),
      now: () => new Date(),
    })
    const cancel = vi.fn(() => Promise.resolve())
    const { provider, cost } = costProvider('spender', cancel)
    manager.register(provider)

    manager.start({ providerId: 'spender', title: 'T', prompt: 'P', cwd: '/tmp' })

    cost(1.5)

    const breach = store.list().find((event) => event.type === 'budget.exceeded')
    expect(breach?.payload).toMatchObject({ scope: 'day' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('refuses to start a new session when a window is already spent', () => {
    const store = new EventStore()
    // Pre-load spend for today from a prior session.
    store.append('cost.usage', {
      sessionId: 'prior',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      usd: 10,
    })
    const types: string[] = []
    const started = vi.fn()
    const manager = new SessionManager(store, (event) => types.push(event.type), {
      getBudgets: () => ({ session: null, hour: null, day: 5, week: null, month: null }),
    })
    manager.register({
      ...instantProvider('x'),
      id: 'x',
      startSession() {
        started()
        return { send: () => Promise.resolve(), cancel: () => Promise.resolve() }
      },
    })

    manager.start({ providerId: 'x', title: 'T', prompt: 'P', cwd: '/tmp' })

    // Provider never ran; a coherent started → exceeded → failed was logged.
    expect(started).not.toHaveBeenCalled()
    expect(types).toEqual(['session.started', 'budget.exceeded', 'session.ended'])
    const breach = store.list().find((event) => event.type === 'budget.exceeded')
    expect(breach?.payload).toMatchObject({ scope: 'day', usedUsd: 10, capUsd: 5 })
    expect(manager.activeCount()).toBe(0)
  })

  it('leaves an uncapped window and session alone', () => {
    const store = new EventStore()
    const types: string[] = []
    const manager = new SessionManager(store, (event) => types.push(event.type), {
      getBudgets: onlySession(null),
    })
    const { provider, cost } = costProvider('free')
    manager.register(provider)

    manager.start({ providerId: 'free', title: 'T', prompt: 'P', cwd: '/tmp' })
    cost(1000)

    expect(types).not.toContain('budget.exceeded')
  })

  it('does not breach when session and window caps are both under', () => {
    const store = new EventStore()
    const types: string[] = []
    const manager = new SessionManager(store, (event) => types.push(event.type), {
      // Session cap present but generous; day cap present but not reached.
      getBudgets: () => ({ session: 100, hour: null, day: 100, week: null, month: null }),
    })
    const { provider, cost } = costProvider('modest')
    manager.register(provider)

    manager.start({ providerId: 'modest', title: 'T', prompt: 'P', cwd: '/tmp' })
    cost(1.5)

    expect(types).not.toContain('budget.exceeded')
  })

  it('breaches the day window even when a generous session cap is not reached', () => {
    const store = new EventStore()
    const types: string[] = []
    const manager = new SessionManager(store, (event) => types.push(event.type), {
      getBudgets: () => ({ session: 100, hour: null, day: 1, week: null, month: null }),
    })
    const cancel = vi.fn(() => Promise.resolve())
    const { provider, cost } = costProvider('spender', cancel)
    manager.register(provider)

    manager.start({ providerId: 'spender', title: 'T', prompt: 'P', cwd: '/tmp' })
    cost(1.5)

    const breach = store.list().find((event) => event.type === 'budget.exceeded')
    expect(breach?.payload).toMatchObject({ scope: 'day' })
  })

  it('runs the real mock provider end to end through the store', async () => {
    const store = new EventStore()
    const types: string[] = []
    const manager = new SessionManager(store, (event) => types.push(event.type))
    manager.register(createMockProvider(() => Promise.resolve()))

    manager.start({ providerId: 'mock', title: 'Demo', prompt: 'demo', cwd: '/tmp' })
    await vi.waitFor(() => {
      expect(types.at(-1)).toBe('session.ended')
    })

    // 10 provider events + the opening prompt logged as a user message.
    expect(store.count()).toBe(11)
  })
})
