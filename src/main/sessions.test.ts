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

    expect(store.count()).toBe(1)
    expect(store.list()[0]?.type).toBe('session.started')
    expect(store.list()[0]?.payload).toMatchObject({ sessionId, title: 'T' })
    expect(forwarded.map((event) => event.type)).toEqual(['session.started'])
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

    const [generated, fixed] = store.list()
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
    const message = events.find((event) => event.type === 'user.message')
    expect(message?.payload).toEqual({ sessionId, text: 'keep going' })
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
    const message = events.find((event) => event.type === 'user.message')
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

    expect(store.count()).toBe(10)
  })
})
