import { describe, expect, it, vi } from 'vitest'

import type { StoredEvent } from '../shared/events'
import { EventStore } from './eventStore'
import { createMockProvider } from './providers/mock'
import { SessionManager } from './sessions'
import type { AgentProvider } from './providers/types'

function instantProvider(id: string): AgentProvider {
  return {
    id,
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

  it('cancelling an unknown session is a no-op', async () => {
    const manager = new SessionManager(new EventStore())

    await expect(manager.cancel('session_missing')).resolves.toBeUndefined()
  })

  it('uses the default no-op onEvent when none is provided', () => {
    const manager = new SessionManager(new EventStore())
    manager.register(instantProvider('a'))

    expect(() =>
      manager.start({ providerId: 'a', title: 'T', prompt: 'P', cwd: '/tmp' }),
    ).not.toThrow()
  })

  it('stops a session that exceeds its budget and audits the breach', async () => {
    const store = new EventStore()
    const types: string[] = []
    const manager = new SessionManager(store, (event) => types.push(event.type))
    const cancel = vi.fn(() => Promise.resolve())
    let emitCost: (usd: number) => void = () => undefined
    manager.register({
      ...instantProvider('spender'),
      id: 'spender',
      startSession(context, emit) {
        emit('session.started', {
          sessionId: context.sessionId,
          agentId: context.agentId,
          workspaceId: context.workspaceId,
          title: context.title,
        })
        emitCost = (usd) =>
          emit('cost.usage', {
            sessionId: context.sessionId,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            usd,
          })
        return { send: () => Promise.resolve(), cancel }
      },
    })

    manager.start({
      providerId: 'spender',
      title: 'T',
      prompt: 'P',
      cwd: '/tmp',
      budgetUsd: 5,
    })

    emitCost(3)
    expect(types).not.toContain('budget.exceeded')
    expect(cancel).not.toHaveBeenCalled()

    emitCost(3)
    expect(types).toContain('budget.exceeded')
    expect(cancel).toHaveBeenCalledOnce()
    const breach = store.list().find((event) => event.type === 'budget.exceeded')
    expect(breach?.payload).toMatchObject({ usedUsd: 6, capUsd: 5 })
  })

  it('applies the manager default budget when a session sets none', () => {
    const store = new EventStore()
    const types: string[] = []
    const manager = new SessionManager(store, (event) => types.push(event.type), {
      defaultBudgetUsd: 0.001,
    })
    manager.register({
      ...instantProvider('cheap'),
      id: 'cheap',
      startSession(context, emit) {
        emit('cost.usage', {
          sessionId: context.sessionId,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          usd: 0.01,
        })
        return { send: () => Promise.resolve(), cancel: () => Promise.resolve() }
      },
    })

    manager.start({ providerId: 'cheap', title: 'T', prompt: 'P', cwd: '/tmp' })

    expect(types).toContain('budget.exceeded')
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
