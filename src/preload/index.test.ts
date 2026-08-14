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

  it('routes events.count, events.totalCost, and events.diffs over IPC', async () => {
    await bridge.events.count()
    await bridge.events.totalCost()
    await bridge.events.diffs('session_7')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:count')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:total-cost')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('events:diffs', 'session_7')
  })

  it('routes settings get/set over IPC', async () => {
    await bridge.settings.getBudgets()
    await bridge.settings.setBudget('day', 12)
    await bridge.settings.getApiKeyMode()
    await bridge.settings.setApiKeyMode(true)
    await bridge.settings.getPreviewTarget()
    await bridge.settings.setPreviewTarget('http://localhost:3001/')
    await bridge.settings.getPreviewSettleMs()
    await bridge.settings.setPreviewSettleMs(900)
    await bridge.settings.getWorktreePreview()
    await bridge.settings.setWorktreePreview(true)
    await bridge.settings.getPreviewServerCommand()
    await bridge.settings.setPreviewServerCommand('vite')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:get-budgets')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:set-budget', 'day', 12)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:get-api-key-mode')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:set-api-key-mode', true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:get-preview-target')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'settings:set-preview-target',
      'http://localhost:3001/',
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:get-preview-settle-ms')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:set-preview-settle-ms', 900)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:get-worktree-preview')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:set-worktree-preview', true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('settings:get-preview-server-command')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'settings:set-preview-server-command',
      'vite',
    )
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

  it('routes agent.current, startDemo, startTask, send, cancel, and dismiss over IPC', async () => {
    await bridge.agent.current()
    await bridge.agent.startDemo()
    await bridge.agent.startTask('do the thing')
    await bridge.agent.send('session_9', 'keep going')
    await bridge.agent.cancel('session_9')
    await bridge.agent.dismiss('session_9')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agent:current')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agent:start-demo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'agent:start-task',
      'do the thing',
      undefined,
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'agent:send',
      'session_9',
      'keep going',
      undefined,
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agent:cancel', 'session_9')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agent:dismiss', 'session_9')
  })

  it('routes credential set/has/clear and the API-key switch over IPC', async () => {
    await bridge.agent.switchToApiKey('session_9')
    await bridge.agent.switchToSubscription('session_9')
    await bridge.credentials.set('claude', 'sk-123', true)
    await bridge.credentials.has('claude')
    await bridge.credentials.clear('claude')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agent:switch-credential', 'session_9')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agent:switch-subscription', 'session_9')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('credentials:set', 'claude', 'sk-123', true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('credentials:has', 'claude')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('credentials:clear', 'claude')
  })

  it('routes preview capture, image, and component pinning over IPC', async () => {
    await bridge.preview.capture('session_9')
    await bridge.preview.capture('session_9', 'http://localhost:5173/')
    await bridge.preview.image('shot_1')
    await bridge.preview.getComponent()
    await bridge.preview.setComponent('/app', 'src/Cart.tsx', 'src/Providers.tsx', '{ n: 1 }')
    await bridge.preview.inferProps('/app', 'src/Cart.tsx')
    await bridge.preview.inferWrapper('/app', 'src/Cart.tsx')
    await bridge.preview.chooseFolder()
    await bridge.preview.chooseFile('/app')
    await bridge.preview.startWorktreeServer('session_9')
    await bridge.preview.stopWorktreeServers()
    await bridge.preview.worktreeServerCount()
    await bridge.preview.worktreeDepsChanged('session_9')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('preview:capture', 'session_9', undefined)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'preview:capture',
      'session_9',
      'http://localhost:5173/',
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('preview:image', 'shot_1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('preview:get-component')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'preview:set-component',
      '/app',
      'src/Cart.tsx',
      'src/Providers.tsx',
      '{ n: 1 }',
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'preview:infer-props',
      '/app',
      'src/Cart.tsx',
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'preview:infer-wrapper',
      '/app',
      'src/Cart.tsx',
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('dialog:choose-folder')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('dialog:choose-file', '/app')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'preview:start-worktree-server',
      'session_9',
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('preview:stop-worktree-servers')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('preview:worktree-server-count')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'preview:worktree-deps-changed',
      'session_9',
    )
  })

  it('routes the task queue over IPC', async () => {
    await bridge.queue.add('a task')
    await bridge.queue.remove('task_1')
    await bridge.queue.dispatch('task_1', 'a task')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('queue:add', 'a task')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('queue:remove', 'task_1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('queue:dispatch', 'task_1', 'a task')
  })

  it('routes checkpoints over IPC', async () => {
    await bridge.checkpoints.create('session_1', 'before change')
    await bridge.checkpoints.restore('session_1', 'checkpoint_1', 'sha_abc')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'checkpoints:create',
      'session_1',
      'before change',
    )
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
      'checkpoints:restore',
      'session_1',
      'checkpoint_1',
      'sha_abc',
    )
  })

  it('routes approvals over IPC', async () => {
    await bridge.approvals.pending()
    await bridge.approvals.resolve('approval_1', true)
    await bridge.approvals.undo('approval_1')

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('approvals:pending')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('approvals:resolve', 'approval_1', true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('approvals:undo', 'approval_1')
  })

  it('routes worktree summary and cleanup over IPC', async () => {
    await bridge.worktrees.summary()
    await bridge.worktrees.cleanup()

    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('worktrees:summary')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('worktrees:cleanup')
  })
})
