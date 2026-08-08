import { describe, expect, it, vi } from 'vitest'

import type { StoredEvent } from '../shared/events'

const { mockContextBridge, mockIpcRenderer } = vi.hoisted(() => ({
  mockContextBridge: { exposeInMainWorld: vi.fn() },
  mockIpcRenderer: {
    invoke: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  contextBridge: mockContextBridge,
  ipcRenderer: mockIpcRenderer,
}))

import { bridge } from './index'

describe('preload bridge', () => {
  it('exposes the bridge to the renderer as window.agentinator', () => {
    expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledWith('agentinator', bridge)
  })

  it('routes events.count and events.totalCost over IPC', async () => {
    await bridge.events.count()
    await bridge.events.totalCost()

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:count')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:total-cost')
  })

  it('routes settings get/set over IPC', async () => {
    await bridge.settings.getBudgetUsd()
    await bridge.settings.setBudgetUsd(12)

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:get-budget')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:set-budget', 12)
  })

  it('routes events.list over IPC with the given cursor', async () => {
    await bridge.events.list(7)

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:list', 7)
  })

  it('defaults the list cursor to the start of the log', async () => {
    await bridge.events.list()

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:list', 0)
  })

  it('routes events.tail over IPC with and without a cursor', async () => {
    await bridge.events.tail(50, 10)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:tail', 50, 10)

    await bridge.events.tail(50)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:tail', 50, undefined)
  })

  it('routes events.search over IPC', async () => {
    await bridge.events.search('greet', 100)

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:search', 'greet', 100)
  })

  it('subscribes to appended events and unwraps the IPC envelope', () => {
    const listener = vi.fn()

    bridge.events.onAppended(listener)

    expect(mockIpcRenderer.on).toHaveBeenCalledWith('events:appended', expect.any(Function))
    const wrapped = mockIpcRenderer.on.mock.calls.at(-1)?.[1] as (
      event: unknown,
      stored: StoredEvent,
    ) => void
    const stored = { seq: 4, ts: 't', type: 'agent.text', payload: {} } as unknown as StoredEvent
    wrapped(undefined, stored)
    expect(listener).toHaveBeenCalledWith(stored)
  })

  it('unsubscribes the same wrapped listener it registered', () => {
    const unsubscribe = bridge.events.onAppended(vi.fn())
    const wrapped = mockIpcRenderer.on.mock.calls.at(-1)?.[1] as unknown

    unsubscribe()

    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('events:appended', wrapped)
  })

  it('routes agent.startDemo and agent.cancel over IPC', async () => {
    await bridge.agent.startDemo()
    await bridge.agent.cancel('session_9')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agent:start-demo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agent:cancel', 'session_9')
  })

  it('routes approvals over IPC', async () => {
    await bridge.approvals.pending()
    await bridge.approvals.resolve('approval_1', true)
    await bridge.approvals.undo('approval_1')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('approvals:pending')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('approvals:resolve', 'approval_1', true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('approvals:undo', 'approval_1')
  })
})
