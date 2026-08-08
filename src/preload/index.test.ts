import { describe, expect, it, vi } from 'vitest'

const { mockContextBridge, mockIpcRenderer } = vi.hoisted(() => ({
  mockContextBridge: { exposeInMainWorld: vi.fn() },
  mockIpcRenderer: { invoke: vi.fn(() => Promise.resolve()) },
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

  it('routes events.count over IPC', async () => {
    await bridge.events.count()

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:count')
  })

  it('routes events.list over IPC with the given cursor', async () => {
    await bridge.events.list(7)

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:list', 7)
  })

  it('defaults the list cursor to the start of the log', async () => {
    await bridge.events.list()

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:list', 0)
  })
})
