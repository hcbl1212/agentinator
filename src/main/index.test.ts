import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EventStore } from './eventStore'

const {
  mockApp,
  MockBrowserWindow,
  MockNotification,
  mockShell,
  mockDialog,
  mockIpcMain,
  mockSafeStorage,
} = vi.hoisted(() => {
  type WindowOpenHandler = (details: { url: string }) => { action: 'deny' }

  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []
    static getAllWindows = vi.fn((): MockBrowserWindow[] => [])
    options: Record<string, unknown>
    loadFile = vi.fn()
    loadURL = vi.fn()
    windowOpenHandler: WindowOpenHandler | undefined
    webContents = {
      send: vi.fn(),
      setWindowOpenHandler: (handler: WindowOpenHandler): void => {
        this.windowOpenHandler = handler
      },
    }

    constructor(options: Record<string, unknown>) {
      this.options = options
      MockBrowserWindow.instances.push(this)
    }
  }

  class MockNotification {
    static instances: MockNotification[] = []
    options: { title?: string; body?: string }
    show = vi.fn()

    constructor(options: { title?: string; body?: string }) {
      this.options = options
      MockNotification.instances.push(this)
    }
  }

  return {
    MockBrowserWindow,
    MockNotification,
    mockApp: {
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      quit: vi.fn(),
      getPath: vi.fn(),
      getAppPath: vi.fn(() => '/app'),
      getVersion: vi.fn(() => '0.1.0-test'),
      dock: { setBadge: vi.fn() },
    },
    mockShell: { openExternal: vi.fn(() => Promise.resolve()) },
    mockDialog: {
      showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    },
    mockIpcMain: { handle: vi.fn() },
    mockSafeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((s: string) => Buffer.from(s, 'utf8')),
      decryptString: vi.fn((b: Buffer) => b.toString('utf8')),
    },
  }
})

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: MockBrowserWindow,
  Notification: MockNotification,
  shell: mockShell,
  dialog: mockDialog,
  ipcMain: mockIpcMain,
  safeStorage: mockSafeStorage,
}))

// The SDK spawns a CLI when queried; tests must never construct the real one.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}))

import type { StoredEvent } from '../shared/events'
import {
  bootstrap,
  broadcastEvent,
  createWindow,
  makeEmitStored,
  registerAgentIpc,
  registerApprovalIpc,
  registerCredentialsIpc,
  registerDialogIpc,
  registerEventIpc,
  createCheckpoint,
  mainEventSink,
  nativeAttentionNotifier,
  registerCheckpointIpc,
  registerPreviewIpc,
  resolveWorktreePath,
  restoreCheckpoint,
  registerQueueIpc,
  registerSettingsIpc,
  registerWorktreeIpc,
  registerWorktreeServerIpc,
  resolveWorktreeDepsChanged,
  resolveWorktreePreview,
  safeEncryptor,
  startAgentTask,
  taskProviderId,
  taskTitle,
} from './index'
import type { OpenDialog } from './index'
import type { AttentionTracker } from './attention'
import type { ComponentWorkbench } from './componentWorkbench'
import type { DevServers } from './devServers'
import type { GitRunner } from './git'
import type { WorktreeJanitor } from './worktreeGc'
import type { PreviewController } from './preview'
import type { CredentialVault } from './credentials'
import type { SessionManager } from './sessions'
import type { SettingsStore } from './settingsStore'

// index.ts has no import-time side effects (see entry.ts), so this runs
// before any code can open a store: every getPath call lands in a temp dir.
mockApp.getPath.mockReturnValue(mkdtempSync(join(tmpdir(), 'agentinator-test-')))

function fakeStore(
  openSessions: string[] = [],
  sessionEvents: Record<string, { type: string }[]> = {},
): EventStore {
  return {
    append: vi.fn(),
    count: vi.fn(() => 42),
    totalCostUsd: vi.fn(() => 1.5),
    latestDiffs: vi.fn(() => []),
    list: vi.fn(() => []),
    tail: vi.fn(() => []),
    search: vi.fn(() => []),
    openSessionIds: vi.fn(() => openSessions),
    listBySession: vi.fn((id: string) => sessionEvents[id] ?? []),
    endedWorktrees: vi.fn(() => []),
    close: vi.fn(),
  } as unknown as EventStore
}

function fakeSettings(): SettingsStore {
  return {
    budgets: vi.fn(() => ({ session: 5, hour: null, day: null, week: null, month: null })),
    setBudget: vi.fn(),
    apiKeyMode: vi.fn(() => false),
    setApiKeyMode: vi.fn(),
    previewTarget: vi.fn(() => undefined),
    setPreviewTarget: vi.fn(),
    previewSettleMs: vi.fn(() => 600),
    setPreviewSettleMs: vi.fn(),
    worktreePreview: vi.fn(() => false),
    setWorktreePreview: vi.fn(),
    previewServerCommand: vi.fn(() => 'npm run dev'),
    setPreviewServerCommand: vi.fn(),
    component: vi.fn(() => undefined),
    setComponent: vi.fn(),
    secrets: vi.fn(() => []),
    saveSecret: vi.fn(),
    readSecret: vi.fn(),
    deleteSecret: vi.fn(),
    close: vi.fn(),
  } as unknown as SettingsStore
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  MockBrowserWindow.instances = []
})

describe('createWindow', () => {
  it('creates a window titled Agentinator with an isolated preload bridge', () => {
    const window = createWindow() as unknown as InstanceType<typeof MockBrowserWindow>

    expect(window.options['title']).toBe('Agentinator')
    expect(window.options['webPreferences']).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      preload: expect.stringContaining('preload/index.mjs') as unknown,
    })
  })

  it('loads the bundled renderer file when no dev server URL is set', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined)

    const window = createWindow() as unknown as InstanceType<typeof MockBrowserWindow>

    expect(window.loadFile).toHaveBeenCalledWith(expect.stringContaining('renderer/index.html'))
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  it('loads the dev server URL when electron-vite provides one', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

    const window = createWindow() as unknown as InstanceType<typeof MockBrowserWindow>

    expect(window.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(window.loadFile).not.toHaveBeenCalled()
  })

  it('opens external links in the system browser and denies new Electron windows', () => {
    const window = createWindow() as unknown as InstanceType<typeof MockBrowserWindow>

    const result = window.windowOpenHandler?.({ url: 'https://example.com' })

    expect(mockShell.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(result).toEqual({ action: 'deny' })
  })
})

describe('registerEventIpc', () => {
  it('serves count and list over the events channels', () => {
    const store = fakeStore()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerEventIpc(store, (channel, listener) => {
      handlers.set(channel, listener)
    })

    expect(handlers.get('events:count')?.(undefined)).toBe(42)
    expect(handlers.get('events:total-cost')?.(undefined)).toBe(1.5)
    expect(handlers.get('events:diffs')?.(undefined)).toEqual([])
    handlers.get('events:list')?.(undefined, 5)
    expect(store.list).toHaveBeenCalledWith(5)
    handlers.get('events:tail')?.(undefined, 100, 7)
    expect(store.tail).toHaveBeenCalledWith(100, 7)
    handlers.get('events:search')?.(undefined, 'greet', 100)
    expect(store.search).toHaveBeenCalledWith('greet', 100)
  })

  it('registers on ipcMain by default', () => {
    registerEventIpc(fakeStore())

    const channels = mockIpcMain.handle.mock.calls.map((call: string[]) => call[0])
    expect(channels).toEqual([
      'events:count',
      'events:total-cost',
      'events:diffs',
      'events:list',
      'events:tail',
      'events:search',
    ])
  })
})

describe('registerAgentIpc', () => {
  function fakeManager(): {
    start: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    dismiss: ReturnType<typeof vi.fn>
    switchCredential: ReturnType<typeof vi.fn>
    describeProvider: ReturnType<typeof vi.fn>
  } {
    return {
      start: vi.fn(() => 'session_new'),
      send: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(() => Promise.resolve()),
      dismiss: vi.fn(() => Promise.resolve()),
      switchCredential: vi.fn(() => Promise.resolve()),
      describeProvider: vi.fn(() => ({ providerId: 'claude', label: 'Claude' })),
    }
  }

  it('reports the current task agent, falling back when the provider is unknown', () => {
    const manager = fakeManager()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerAgentIpc(manager as unknown as SessionManager, (channel, listener) => {
      handlers.set(channel, listener)
    })

    expect(handlers.get('agent:current')?.(undefined)).toEqual({
      providerId: 'claude',
      label: 'Claude',
    })

    manager.describeProvider.mockReturnValueOnce(undefined)
    expect(handlers.get('agent:current')?.(undefined)).toEqual({
      providerId: 'claude',
      label: 'claude',
    })
  })

  it('starts the mock demo session in the current working directory', () => {
    const manager = fakeManager()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerAgentIpc(manager as unknown as SessionManager, (channel, listener) => {
      handlers.set(channel, listener)
    })

    expect(handlers.get('agent:start-demo')?.(undefined)).toBe('session_new')
    expect(manager.start).toHaveBeenCalledWith({
      providerId: 'mock',
      title: 'Demo: greet util',
      prompt: 'Add a greet util with a test.',
      cwd: process.cwd(),
    })
  })

  it('starts a real Claude task with the prompt as the session prompt', () => {
    const manager = fakeManager()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerAgentIpc(manager as unknown as SessionManager, (channel, listener) => {
      handlers.set(channel, listener)
    })
    handlers.get('agent:start-task')?.(undefined, 'Add a hello util')

    expect(manager.start).toHaveBeenCalledWith({
      providerId: 'claude',
      title: 'Add a hello util',
      prompt: 'Add a hello util',
      cwd: process.cwd(),
    })
  })

  it('drives the e2e provider for tasks when AGENTINATOR_MOCK_TASKS is set (e2e mode)', () => {
    vi.stubEnv('AGENTINATOR_MOCK_TASKS', '1')
    const manager = fakeManager()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerAgentIpc(manager as unknown as SessionManager, (channel, listener) => {
      handlers.set(channel, listener)
    })
    handlers.get('agent:start-task')?.(undefined, 'Add a hello util')

    expect(manager.start).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'e2e' }))
  })

  it('routes a follow-up message to the session manager', () => {
    const manager = fakeManager()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerAgentIpc(manager as unknown as SessionManager, (channel, listener) => {
      handlers.set(channel, listener)
    })
    void handlers.get('agent:send')?.(undefined, 'session_7', 'keep going')

    expect(manager.send).toHaveBeenCalledWith('session_7', 'keep going', undefined)
  })

  it('routes cancellation to the session manager', () => {
    const manager = fakeManager()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerAgentIpc(manager as unknown as SessionManager, (channel, listener) => {
      handlers.set(channel, listener)
    })
    void handlers.get('agent:cancel')?.(undefined, 'session_7')

    expect(manager.cancel).toHaveBeenCalledWith('session_7')
  })

  it('registers on ipcMain by default', () => {
    registerAgentIpc(fakeManager() as unknown as SessionManager)

    const channels = mockIpcMain.handle.mock.calls.map((call: string[]) => call[0])
    expect(channels).toEqual([
      'agent:current',
      'agent:start-demo',
      'agent:start-task',
      'agent:send',
      'agent:cancel',
      'agent:dismiss',
    ])
  })

  it('routes a dismiss to the session manager', () => {
    const manager = fakeManager()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerAgentIpc(manager as unknown as SessionManager, (channel, listener) => {
      handlers.set(channel, listener)
    })
    handlers.get('agent:dismiss')?.(undefined, 'session_x')

    expect(manager.dismiss).toHaveBeenCalledWith('session_x')
  })
})

describe('registerCredentialsIpc', () => {
  function fakeVault(key: string | undefined): {
    set: ReturnType<typeof vi.fn>
    has: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
  } {
    return {
      set: vi.fn(),
      has: vi.fn(() => true),
      get: vi.fn(() => key),
      clear: vi.fn(),
    }
  }

  function wire(vault: ReturnType<typeof fakeVault>, store: EventStore) {
    const manager = { switchCredential: vi.fn(() => Promise.resolve()) }
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerCredentialsIpc(
      vault as unknown as CredentialVault,
      manager as unknown as SessionManager,
      store,
      (channel, listener) => handlers.set(channel, listener),
    )
    return { manager, handlers }
  }

  it('sets, checks, and clears credentials', () => {
    const vault = fakeVault('sk-live')
    const { handlers } = wire(vault, new EventStore())

    handlers.get('credentials:set')?.(undefined, 'claude', 'sk-123', true)
    expect(vault.set).toHaveBeenCalledWith('claude', 'sk-123', true)
    expect(handlers.get('credentials:has')?.(undefined, 'claude')).toBe(true)
    handlers.get('credentials:clear')?.(undefined, 'claude')
    expect(vault.clear).toHaveBeenCalledWith('claude')
  })

  it('switches a session onto its provider’s stored key', async () => {
    const store = new EventStore()
    store.append('session.started', {
      sessionId: 's1',
      agentId: 'a',
      workspaceId: 'w',
      title: 'T',
      providerId: 'claude',
    })
    const vault = fakeVault('sk-live')
    const { manager, handlers } = wire(vault, store)

    await handlers.get('agent:switch-credential')?.(undefined, 's1')

    expect(vault.get).toHaveBeenCalledWith('claude')
    expect(manager.switchCredential).toHaveBeenCalledWith('s1', 'sk-live')
    store.close()
  })

  it('switches a session back to the subscription with no key', async () => {
    const { manager, handlers } = wire(fakeVault('sk-live'), new EventStore())

    await handlers.get('agent:switch-subscription')?.(undefined, 's1')

    expect(manager.switchCredential).toHaveBeenCalledWith('s1')
  })

  it('does nothing when there is no stored key (or no provider)', async () => {
    const vault = fakeVault(undefined) // no key
    const store = new EventStore()
    store.append('session.started', {
      sessionId: 's1',
      agentId: 'a',
      workspaceId: 'w',
      title: 'T',
      providerId: 'claude',
    })
    const withKey = wire(vault, store)
    await withKey.handlers.get('agent:switch-credential')?.(undefined, 's1')
    expect(withKey.manager.switchCredential).not.toHaveBeenCalled()

    // No session.started (unknown provider) → also a no-op.
    const noProvider = wire(fakeVault('sk-live'), new EventStore())
    await noProvider.handlers.get('agent:switch-credential')?.(undefined, 'missing')
    expect(noProvider.manager.switchCredential).not.toHaveBeenCalled()
    store.close()
  })
})

describe('safeEncryptor', () => {
  it('round-trips through the OS keychain (safeStorage)', () => {
    const enc = safeEncryptor()
    expect(enc.available).toBe(true)
    expect(enc.decrypt(enc.encrypt('sk-secret'))).toBe('sk-secret')
  })
})

describe('taskTitle', () => {
  it('uses the first line of the prompt', () => {
    expect(taskTitle('Add a util\nwith details')).toBe('Add a util')
  })

  it('truncates a long first line', () => {
    const title = taskTitle('x'.repeat(80))
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBe(58)
  })

  it('trims surrounding whitespace', () => {
    expect(taskTitle('  spaced  ')).toBe('spaced')
  })
})

describe('registerSettingsIpc', () => {
  it('serves and updates per-scope budgets', () => {
    const budgets = { session: 5, hour: null, day: null, week: null, month: null }
    const settings = {
      budgets: vi.fn(() => budgets),
      setBudget: vi.fn(),
      apiKeyMode: vi.fn(() => true),
      setApiKeyMode: vi.fn(),
      previewTarget: vi.fn(() => 'http://localhost:3001/'),
      setPreviewTarget: vi.fn(),
      previewSettleMs: vi.fn(() => 700),
      setPreviewSettleMs: vi.fn(),
      worktreePreview: vi.fn(() => true),
      setWorktreePreview: vi.fn(),
      previewServerCommand: vi.fn(() => 'npm run dev'),
      setPreviewServerCommand: vi.fn(),
    }
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerSettingsIpc(settings as unknown as SettingsStore, (channel, listener) => {
      handlers.set(channel, listener)
    })

    expect(handlers.get('settings:get-budgets')?.(undefined)).toBe(budgets)
    handlers.get('settings:set-budget')?.(undefined, 'day', 12)
    expect(settings.setBudget).toHaveBeenCalledWith('day', 12)
    expect(handlers.get('settings:get-api-key-mode')?.(undefined)).toBe(true)
    handlers.get('settings:set-api-key-mode')?.(undefined, true)
    expect(settings.setApiKeyMode).toHaveBeenCalledWith(true)
    expect(handlers.get('settings:get-preview-target')?.(undefined)).toBe('http://localhost:3001/')
    handlers.get('settings:set-preview-target')?.(undefined, 'http://localhost:3001/')
    expect(settings.setPreviewTarget).toHaveBeenCalledWith('http://localhost:3001/')
    expect(handlers.get('settings:get-preview-settle-ms')?.(undefined)).toBe(700)
    handlers.get('settings:set-preview-settle-ms')?.(undefined, 900)
    expect(settings.setPreviewSettleMs).toHaveBeenCalledWith(900)
    expect(handlers.get('settings:get-worktree-preview')?.(undefined)).toBe(true)
    handlers.get('settings:set-worktree-preview')?.(undefined, true)
    expect(settings.setWorktreePreview).toHaveBeenCalledWith(true)
    expect(handlers.get('settings:get-preview-server-command')?.(undefined)).toBe('npm run dev')
    handlers.get('settings:set-preview-server-command')?.(undefined, 'pnpm dev')
    expect(settings.setPreviewServerCommand).toHaveBeenCalledWith('pnpm dev')
  })

  it('returns null for an unset preview target', () => {
    const settings = { ...fakeSettings(), previewTarget: vi.fn(() => undefined) }
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerSettingsIpc(settings as unknown as SettingsStore, (channel, listener) => {
      handlers.set(channel, listener)
    })

    expect(handlers.get('settings:get-preview-target')?.(undefined)).toBeNull()
  })

  it('registers on ipcMain by default', () => {
    registerSettingsIpc(fakeSettings())

    const channels = mockIpcMain.handle.mock.calls.map((call: string[]) => call[0])
    expect(channels).toEqual([
      'settings:get-budgets',
      'settings:set-budget',
      'settings:get-api-key-mode',
      'settings:set-api-key-mode',
      'settings:get-preview-target',
      'settings:set-preview-target',
      'settings:get-preview-settle-ms',
      'settings:set-preview-settle-ms',
      'settings:get-worktree-preview',
      'settings:set-worktree-preview',
      'settings:get-preview-server-command',
      'settings:set-preview-server-command',
    ])
  })
})

describe('registerWorktreeIpc', () => {
  it('routes worktree summary and cleanup to the janitor', () => {
    const janitor = {
      summary: vi.fn(() => ({ count: 2, bytes: 2048 })),
      cleanup: vi.fn(() => ({ count: 2, bytes: 2048 })),
    }
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerWorktreeIpc(janitor as unknown as WorktreeJanitor, (channel, listener) => {
      handlers.set(channel, listener)
    })

    expect(handlers.get('worktrees:summary')?.(undefined)).toEqual({ count: 2, bytes: 2048 })
    expect(handlers.get('worktrees:cleanup')?.(undefined)).toEqual({ count: 2, bytes: 2048 })
    expect(janitor.cleanup).toHaveBeenCalledOnce()
  })

  it('registers on ipcMain by default', () => {
    registerWorktreeIpc({ summary: vi.fn(), cleanup: vi.fn() } as unknown as WorktreeJanitor)

    const channels = mockIpcMain.handle.mock.calls.map((call: string[]) => call[0])
    expect(channels).toEqual(['worktrees:summary', 'worktrees:cleanup'])
  })
})

describe('mainEventSink', () => {
  it('broadcasts, reaps the server on end, and feeds the attention tracker', () => {
    const stop = vi.fn()
    const broadcast = vi.fn()
    const observe = vi.fn()
    const sink = mainEventSink(
      { stop } as unknown as DevServers,
      { observe } as unknown as AttentionTracker,
      broadcast,
    )

    const ended = { type: 'session.ended', payload: { sessionId: 's1' } } as unknown as StoredEvent
    const text = { type: 'agent.text', payload: { sessionId: 's1' } } as unknown as StoredEvent
    sink(text)
    sink(ended)

    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(observe).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledExactlyOnceWith('s1')
  })
})

describe('nativeAttentionNotifier', () => {
  it('shows a system notification and sets/clears the dock badge', () => {
    const notifier = nativeAttentionNotifier()

    notifier.notify('Approval needed', 'run Bash')
    const shown = MockNotification.instances.at(-1)
    expect(shown?.options).toEqual({ title: 'Approval needed', body: 'run Bash' })
    expect(shown?.show).toHaveBeenCalledOnce()

    notifier.setBadge(3)
    expect(mockApp.dock.setBadge).toHaveBeenCalledWith('3')
    notifier.setBadge(0)
    expect(mockApp.dock.setBadge).toHaveBeenCalledWith('')
  })

  it('is a no-op for the dock badge off macOS (no app.dock)', () => {
    const real = mockApp.dock
    // @ts-expect-error — simulate a platform where app.dock is absent.
    mockApp.dock = undefined
    try {
      expect(() => nativeAttentionNotifier().setBadge(2)).not.toThrow()
    } finally {
      mockApp.dock = real
    }
  })
})

describe('registerWorktreeServerIpc', () => {
  it('routes start, stop-all, and count to the dev-server manager', async () => {
    const start = vi.fn(() => Promise.resolve({ url: 'http://localhost:5199' }))
    const stopAll = vi.fn()
    const count = vi.fn(() => 3)
    const depsChanged = vi.fn(() => Promise.resolve(true))
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerWorktreeServerIpc(start, stopAll, count, depsChanged, (channel, listener) => {
      handlers.set(channel, listener)
    })

    await expect(handlers.get('preview:start-worktree-server')?.(undefined, 's1')).resolves.toEqual(
      {
        url: 'http://localhost:5199',
      },
    )
    expect(start).toHaveBeenCalledWith('s1')
    handlers.get('preview:stop-worktree-servers')?.(undefined)
    expect(stopAll).toHaveBeenCalledOnce()
    expect(handlers.get('preview:worktree-server-count')?.(undefined)).toBe(3)
    await expect(handlers.get('preview:worktree-deps-changed')?.(undefined, 's1')).resolves.toBe(
      true,
    )
    expect(depsChanged).toHaveBeenCalledWith('s1')
  })
})

describe('taskProviderId and startAgentTask', () => {
  it('picks e2e under the mock-tasks flag, else claude', () => {
    vi.stubEnv('AGENTINATOR_MOCK_TASKS', undefined)
    expect(taskProviderId()).toBe('claude')
    vi.stubEnv('AGENTINATOR_MOCK_TASKS', '1')
    expect(taskProviderId()).toBe('e2e')
  })

  it('starts an agent from a prompt with a derived title', () => {
    const start = vi.fn(() => 'session_9')
    const id = startAgentTask({ start } as unknown as SessionManager, 'Add a hello util')

    expect(id).toBe('session_9')
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'claude',
        title: 'Add a hello util',
        prompt: 'Add a hello util',
      }),
    )
  })
})

describe('registerQueueIpc', () => {
  it('queues, removes, and dispatches tasks through the event log', () => {
    const start = vi.fn(() => 'session_9')
    const emit = vi.fn()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerQueueIpc({ start } as unknown as SessionManager, emit, (channel, listener) =>
      handlers.set(channel, listener),
    )

    const taskId = handlers.get('queue:add')?.(undefined, 'do it')
    expect(typeof taskId).toBe('string')
    expect(emit).toHaveBeenCalledWith('task.queued', { taskId, prompt: 'do it' })

    handlers.get('queue:remove')?.(undefined, 'task_1')
    expect(emit).toHaveBeenCalledWith('task.removed', { taskId: 'task_1' })

    const sessionId = handlers.get('queue:dispatch')?.(undefined, 'task_1', 'do it')
    expect(start).toHaveBeenCalledOnce()
    expect(sessionId).toBe('session_9')
    expect(emit).toHaveBeenCalledWith('task.dispatched', {
      taskId: 'task_1',
      sessionId: 'session_9',
    })
  })

  it('registers on ipcMain by default', () => {
    registerQueueIpc({ start: vi.fn() } as unknown as SessionManager, vi.fn())

    const channels = mockIpcMain.handle.mock.calls.map((call: string[]) => call[0])
    expect(channels).toEqual(['queue:add', 'queue:remove', 'queue:dispatch'])
  })
})

describe('checkpoints', () => {
  const storeWith = (worktree?: { repoRoot: string; path: string; branch: string }): EventStore =>
    ({
      listBySession: vi.fn(() => [
        { type: 'session.started', payload: { sessionId: 's1', worktree } },
      ]),
    }) as unknown as EventStore
  const wt = { repoRoot: '/r', path: '/wt', branch: 'b' }

  it('resolveWorktreePath returns the path for an isolated session, else null', () => {
    expect(resolveWorktreePath('s1', storeWith(wt))).toBe('/wt')
    expect(resolveWorktreePath('s1', storeWith(undefined))).toBeNull()
  })

  it('createCheckpoint snapshots the worktree and logs it', () => {
    const emit = vi.fn()
    const checkpoints = { create: vi.fn(() => 'sha_abc'), restore: vi.fn() }
    const id = createCheckpoint('s1', 'before', storeWith(wt), checkpoints, emit)

    expect(checkpoints.create).toHaveBeenCalledWith('/wt', 'before')
    expect(id).toMatch(/^checkpoint_/)
    expect(emit).toHaveBeenCalledWith('checkpoint.created', {
      sessionId: 's1',
      checkpointId: id,
      label: 'before',
      sha: 'sha_abc',
    })
  })

  it('createCheckpoint returns null (no emit) when unisolated or the snapshot fails', () => {
    const emit = vi.fn()
    const notIsolated = { create: vi.fn(), restore: vi.fn() }
    expect(createCheckpoint('s1', 'x', storeWith(undefined), notIsolated, emit)).toBeNull()
    expect(notIsolated.create).not.toHaveBeenCalled()

    const fails = { create: vi.fn(() => null), restore: vi.fn() }
    expect(createCheckpoint('s1', 'x', storeWith(wt), fails, emit)).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('restoreCheckpoint rewinds and logs on success, false + no log otherwise', () => {
    const emit = vi.fn()
    const ok = { create: vi.fn(), restore: vi.fn(() => true) }
    expect(restoreCheckpoint('s1', 'c1', 'sha', storeWith(wt), ok, emit)).toBe(true)
    expect(ok.restore).toHaveBeenCalledWith('/wt', 'sha')
    expect(emit).toHaveBeenCalledWith('checkpoint.restored', {
      sessionId: 's1',
      checkpointId: 'c1',
    })

    emit.mockClear()
    expect(restoreCheckpoint('s1', 'c1', 'sha', storeWith(undefined), ok, emit)).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('registerCheckpointIpc routes create and restore to the closures', () => {
    const create = vi.fn(() => 'checkpoint_1')
    const restore = vi.fn(() => true)
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerCheckpointIpc(create, restore, (channel, listener) => handlers.set(channel, listener))

    expect(handlers.get('checkpoints:create')?.(undefined, 's1', 'lbl')).toBe('checkpoint_1')
    expect(create).toHaveBeenCalledWith('s1', 'lbl')
    expect(handlers.get('checkpoints:restore')?.(undefined, 's1', 'c1', 'sha')).toBe(true)
    expect(restore).toHaveBeenCalledWith('s1', 'c1', 'sha')
  })
})

describe('resolveWorktreeDepsChanged', () => {
  const storeWith = (worktree?: { repoRoot: string; path: string; branch: string }): EventStore =>
    ({
      listBySession: vi.fn(() => [
        { type: 'session.started', payload: { sessionId: 's1', worktree } },
      ]),
    }) as unknown as EventStore

  it('is false (without touching git) when the session is not isolated', async () => {
    const git = vi.fn()
    await expect(
      resolveWorktreeDepsChanged('s1', storeWith(undefined), git as unknown as GitRunner),
    ).resolves.toBe(false)
    expect(git).not.toHaveBeenCalled()
  })

  it('checks the worktree for manifest changes when isolated', async () => {
    const git = vi.fn(() => Promise.resolve('frontend/package.json\n'))
    await expect(
      resolveWorktreeDepsChanged(
        's1',
        storeWith({ repoRoot: '/repo', path: '/wt/s1', branch: 'b' }),
        git as unknown as GitRunner,
      ),
    ).resolves.toBe(true)
    expect(git).toHaveBeenCalledWith(['diff', '--name-only', 'HEAD'], '/wt/s1')
  })
})

describe('resolveWorktreePreview', () => {
  const worktree = { repoRoot: '/repo', path: '/wt/s1', branch: 'agentinator/s1' }
  const startedEvent = (wt?: typeof worktree): { type: string; payload: unknown }[] => [
    {
      type: 'session.started',
      payload: { sessionId: 's1', agentId: 'a', workspaceId: 'w', title: 'T', worktree: wt },
    },
  ]
  const fakeStore = (events: { type: string; payload: unknown }[]): EventStore =>
    ({ listBySession: vi.fn(() => events) }) as unknown as EventStore
  const fakeSettingsFor = (
    on: boolean,
    component?: { root: string; file: string; wrapper?: string; props?: string },
  ): SettingsStore =>
    ({
      worktreePreview: () => on,
      component: () => component,
      previewServerCommand: () => 'npm run dev',
    }) as unknown as SettingsStore

  it('returns null when worktree preview is off', async () => {
    const ensure = vi.fn()
    await expect(
      resolveWorktreePreview('s1', fakeStore([]), fakeSettingsFor(false), {
        ensure,
      } as unknown as DevServers),
    ).resolves.toBeNull()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('returns null when no component is pinned', async () => {
    await expect(
      resolveWorktreePreview('s1', fakeStore([]), fakeSettingsFor(true, undefined), {
        ensure: vi.fn(),
      } as unknown as DevServers),
    ).resolves.toBeNull()
  })

  it('returns null when the session is not an isolated agent', async () => {
    await expect(
      resolveWorktreePreview(
        's1',
        fakeStore(startedEvent(undefined)),
        fakeSettingsFor(true, { root: '/repo/frontend', file: 'src/X.tsx' }),
        { ensure: vi.fn() } as unknown as DevServers,
      ),
    ).resolves.toBeNull()
  })

  it('starts the worktree dev server and returns where to write the entry', async () => {
    const ensure = vi.fn(() => Promise.resolve('http://localhost:5199'))
    const result = await resolveWorktreePreview(
      's1',
      fakeStore(startedEvent(worktree)),
      fakeSettingsFor(true, {
        root: '/repo/frontend',
        file: 'src/X.tsx',
        wrapper: 'src/Wrap.tsx',
        props: '{}',
      }),
      { ensure } as unknown as DevServers,
    )

    // The server runs in the worktree's copy of the component's subdir.
    expect(ensure).toHaveBeenCalledWith('s1', '/wt/s1/frontend', '/repo/frontend', 'npm run dev')
    expect(result).toEqual({
      url: 'http://localhost:5199',
      root: '/wt/s1/frontend',
      file: 'src/X.tsx',
      wrapper: 'src/Wrap.tsx',
      props: '{}',
    })
  })
})

describe('registerApprovalIpc', () => {
  it('serves pending approvals and routes resolve/undo to the broker', () => {
    const broker = { pending: vi.fn(() => []), resolve: vi.fn(), undo: vi.fn() }
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerApprovalIpc(broker as never, (channel, listener) => {
      handlers.set(channel, listener)
    })

    expect(handlers.get('approvals:pending')?.(undefined)).toEqual([])
    handlers.get('approvals:resolve')?.(undefined, 'approval_1', false)
    expect(broker.resolve).toHaveBeenCalledWith('approval_1', false)
    handlers.get('approvals:undo')?.(undefined, 'approval_1')
    expect(broker.undo).toHaveBeenCalledWith('approval_1')
  })

  it('registers on ipcMain by default', () => {
    registerApprovalIpc({ pending: vi.fn(), resolve: vi.fn(), undo: vi.fn() } as never)

    const channels = mockIpcMain.handle.mock.calls.map((call: string[]) => call[0])
    expect(channels).toEqual(['approvals:pending', 'approvals:resolve', 'approvals:undo'])
  })
})

describe('registerPreviewIpc', () => {
  function previewSettings(component?: { root: string; file: string }): {
    component: ReturnType<typeof vi.fn>
    setComponent: ReturnType<typeof vi.fn>
  } {
    return { component: vi.fn(() => component), setComponent: vi.fn() }
  }

  type Handlers = Map<string, (event: unknown, ...args: unknown[]) => unknown>

  function register(
    preview: unknown,
    settings: unknown,
    workbench: unknown,
    inferProps: (root: string, file: string) => Promise<string> = vi.fn(() =>
      Promise.resolve('{}'),
    ),
    inferWrapper: (root: string, file: string) => Promise<string> = vi.fn(() =>
      Promise.resolve('export default ({ children }) => children'),
    ),
  ): Handlers {
    const handlers: Handlers = new Map()
    registerPreviewIpc(
      preview as PreviewController,
      settings as SettingsStore,
      workbench as ComponentWorkbench,
      inferProps,
      inferWrapper,
      (channel, listener) => {
        handlers.set(channel, listener)
      },
    )
    return handlers
  }

  it('routes capture (with and without a url) and image to the controller', async () => {
    const preview = {
      capture: vi.fn(() => Promise.resolve('shot_1')),
      image: vi.fn(() => 'YWJj'),
    }
    const handlers = register(preview, previewSettings(), { clear: vi.fn() })

    expect(await handlers.get('preview:capture')?.(undefined, 'session_1', undefined)).toBe(
      'shot_1',
    )
    expect(preview.capture).toHaveBeenCalledWith('session_1', undefined)
    await handlers.get('preview:capture')?.(undefined, 'session_1', 'http://x/')
    expect(preview.capture).toHaveBeenCalledWith('session_1', 'http://x/')
    expect(handlers.get('preview:image')?.(undefined, 'shot_1')).toBe('YWJj')
    expect(preview.image).toHaveBeenCalledWith('shot_1')
  })

  it('pins a component (with props) and clears the entry when unpinned', () => {
    const settings = previewSettings({ root: '/app', file: 'src/Cart.tsx' })
    const workbench = { clear: vi.fn() }
    const handlers = register({ capture: vi.fn(), image: vi.fn() }, settings, workbench)

    expect(handlers.get('preview:get-component')?.(undefined)).toEqual({
      root: '/app',
      file: 'src/Cart.tsx',
    })
    handlers.get('preview:set-component')?.(undefined, '/app', 'src/Cart.tsx', 'src/Wrap.tsx', '{}')
    expect(settings.setComponent).toHaveBeenCalledWith('/app', 'src/Cart.tsx', 'src/Wrap.tsx', '{}')
    // Clearing (blank file) removes the entry from the pinned root first.
    handlers.get('preview:set-component')?.(undefined, '/app', '  ')
    expect(workbench.clear).toHaveBeenCalledWith('/app')
    expect(settings.setComponent).toHaveBeenLastCalledWith('/app', '  ', undefined, undefined)
  })

  it('infers props by delegating to the agent inferrer', async () => {
    const inferProps = vi.fn(() => Promise.resolve('{ n: 1 }'))
    const handlers = register(
      { capture: vi.fn(), image: vi.fn() },
      previewSettings(),
      { clear: vi.fn() },
      inferProps,
    )

    expect(await handlers.get('preview:infer-props')?.(undefined, '/app', 'src/Cart.tsx')).toBe(
      '{ n: 1 }',
    )
    expect(inferProps).toHaveBeenCalledWith('/app', 'src/Cart.tsx')
  })

  it('infers a wrapper: generates the source, writes it, and returns its name', async () => {
    const inferWrapper = vi.fn(() => Promise.resolve('export default ({ children }) => children'))
    const workbench = { clear: vi.fn(), writeWrapper: vi.fn(() => '__agentinator_wrapper.tsx') }
    const handlers = register(
      { capture: vi.fn(), image: vi.fn() },
      previewSettings(),
      workbench,
      undefined,
      inferWrapper,
    )

    expect(await handlers.get('preview:infer-wrapper')?.(undefined, '/app', 'src/Page.tsx')).toBe(
      '__agentinator_wrapper.tsx',
    )
    expect(inferWrapper).toHaveBeenCalledWith('/app', 'src/Page.tsx')
    expect(workbench.writeWrapper).toHaveBeenCalledWith(
      '/app',
      'export default ({ children }) => children',
    )
  })

  it('returns null for an unpinned component and skips the clear', () => {
    const settings = previewSettings(undefined)
    const workbench = { clear: vi.fn() }
    const handlers = register({ capture: vi.fn(), image: vi.fn() }, settings, workbench)

    expect(handlers.get('preview:get-component')?.(undefined)).toBeNull()
    handlers.get('preview:set-component')?.(undefined, '/app', null)
    expect(workbench.clear).not.toHaveBeenCalled()
    expect(settings.setComponent).toHaveBeenCalledWith('/app', null, undefined, undefined)
  })

  it('registers on ipcMain by default', () => {
    registerPreviewIpc(
      { capture: vi.fn(), image: vi.fn() } as unknown as PreviewController,
      previewSettings() as unknown as SettingsStore,
      { clear: vi.fn() } as unknown as ComponentWorkbench,
      vi.fn(() => Promise.resolve('{}')),
      vi.fn(() => Promise.resolve('')),
    )

    const channels = mockIpcMain.handle.mock.calls.map((call: string[]) => call[0])
    expect(channels).toEqual([
      'preview:capture',
      'preview:image',
      'preview:get-component',
      'preview:set-component',
      'preview:infer-props',
      'preview:infer-wrapper',
    ])
  })
})

describe('registerDialogIpc', () => {
  function handlersFor(dialog: OpenDialog): Map<string, (...args: unknown[]) => unknown> {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    registerDialogIpc(dialog, (channel, listener) => {
      handlers.set(channel, listener)
    })
    return handlers
  }

  it('returns the chosen folder, or null when cancelled', async () => {
    const chosen: OpenDialog = vi.fn(() =>
      Promise.resolve({ canceled: false, filePaths: ['/Users/me/app'] }),
    )
    expect(await handlersFor(chosen).get('dialog:choose-folder')?.(undefined)).toBe('/Users/me/app')

    const cancelled: OpenDialog = vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] }))
    expect(await handlersFor(cancelled).get('dialog:choose-folder')?.(undefined)).toBeNull()
  })

  it('returns a chosen file relative to the base, or null when cancelled', async () => {
    const chosen: OpenDialog = vi.fn(() =>
      Promise.resolve({ canceled: false, filePaths: ['/app/src/ui/Cart.tsx'] }),
    )
    const handlers = handlersFor(chosen)

    expect(await handlers.get('dialog:choose-file')?.(undefined, '/app')).toBe('src/ui/Cart.tsx')
    expect(chosen).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openFile'], defaultPath: '/app' }),
    )

    const empty: OpenDialog = vi.fn(() => Promise.resolve({ canceled: false, filePaths: [] }))
    expect(await handlersFor(empty).get('dialog:choose-file')?.(undefined, '/app')).toBeNull()
  })

  it('registers on ipcMain by default', () => {
    registerDialogIpc(mockDialog.showOpenDialog)

    const channels = mockIpcMain.handle.mock.calls.map((call: string[]) => call[0])
    expect(channels).toEqual(['dialog:choose-folder', 'dialog:choose-file'])
  })
})

describe('makeEmitStored', () => {
  it('appends to the store and broadcasts the result', () => {
    const store = fakeStore()
    ;(store.append as ReturnType<typeof vi.fn>).mockReturnValue({
      seq: 1,
      ts: 't',
      type: 'approval.requested',
      payload: {},
    })
    const broadcast = vi.fn()

    const emit = makeEmitStored(store, broadcast)
    const stored = emit('approval.requested', {
      sessionId: 's',
      requestId: 'r',
      tool: 'write',
      input: {},
    })

    expect(store.append).toHaveBeenCalledWith('approval.requested', expect.any(Object))
    expect(broadcast).toHaveBeenCalledWith(stored)
  })
})

describe('broadcastEvent', () => {
  it('sends the appended event to every open window', () => {
    const first = new MockBrowserWindow({})
    const second = new MockBrowserWindow({})
    MockBrowserWindow.getAllWindows.mockReturnValue([first, second])
    const event = { seq: 1, ts: 't', type: 'agent.text', payload: {} } as unknown as StoredEvent

    broadcastEvent(event)

    expect(first.webContents.send).toHaveBeenCalledWith('events:appended', event)
    expect(second.webContents.send).toHaveBeenCalledWith('events:appended', event)
  })
})

describe('bootstrap', () => {
  it('opens the store + settings in userData, records app.started, and serves IPC', async () => {
    const store = fakeStore()
    const createStore = vi.fn(() => store)
    const createSettings = vi.fn(() => fakeSettings())

    const returned = await bootstrap(
      mockApp as never,
      createStore,
      undefined,
      undefined,
      undefined,
      createSettings,
    )

    expect(createStore).toHaveBeenCalledWith(expect.stringContaining('agentinator.db'))
    expect(createSettings).toHaveBeenCalledWith(expect.stringContaining('agentinator-settings.db'))
    expect(store.append).toHaveBeenCalledWith('app.started', { version: '0.1.0-test' })
    expect(mockIpcMain.handle).toHaveBeenCalledWith('events:count', expect.any(Function))
    expect(mockIpcMain.handle).toHaveBeenCalledWith('agent:start-demo', expect.any(Function))
    expect(mockIpcMain.handle).toHaveBeenCalledWith('approvals:pending', expect.any(Function))
    expect(mockIpcMain.handle).toHaveBeenCalledWith('settings:get-budgets', expect.any(Function))
    expect(returned).toBe(store)
    expect(MockBrowserWindow.instances).toHaveLength(1)
  })

  it('wires the preview loop to capture the bundled sample into the store', async () => {
    const store = new EventStore(':memory:')
    const capture = vi.fn(() =>
      Promise.resolve({ png: new Uint8Array([1]), width: 2, height: 3, console: [], network: [] }),
    )

    await bootstrap(
      mockApp as never,
      () => store,
      undefined,
      undefined,
      undefined,
      () => fakeSettings(),
      undefined,
      () => ({ capture }),
      () => ({ put: () => 'shot_x', read: () => new Uint8Array([1]) }),
    )

    const call = (channel: string): ((...args: unknown[]) => unknown) =>
      mockIpcMain.handle.mock.calls.find(([c]: string[]) => c === channel)?.[1] as (
        ...args: unknown[]
      ) => unknown
    const ref = await call('preview:capture')(undefined, 'session_1', undefined)

    expect(ref).toBe('shot_x')
    // The default target is the sample resolved next to the bundled main.
    expect(capture).toHaveBeenCalledWith(
      expect.stringContaining('examples/sample-web/index.html'),
      600,
    )
    expect(call('preview:image')(undefined, 'shot_x')).toBe(Buffer.from([1]).toString('base64'))
    expect(store.list().some((event) => event.type === 'preview.captured')).toBe(true)
    // The worktree janitor is wired to the store: nothing finished yet → empty.
    expect(call('worktrees:summary')(undefined)).toEqual({ count: 0, bytes: 0 })
    // Worktree-server IPC is wired: no isolated session → no server; none running.
    expect(await call('preview:start-worktree-server')(undefined, 'session_1')).toBeNull()
    call('preview:stop-worktree-servers')(undefined)
    expect(call('preview:worktree-server-count')(undefined)).toBe(0)
    expect(await call('preview:worktree-deps-changed')(undefined, 'session_1')).toBe(false)
    // Checkpoint IPC is wired: an unisolated session snapshots/rewinds to nothing.
    expect(call('checkpoints:create')(undefined, 'session_1', 'x')).toBeNull()
    expect(call('checkpoints:restore')(undefined, 'session_1', 'c1', 'sha')).toBe(false)
    store.close()
  })

  it('marks a still-running session left open by a previous run idle', async () => {
    const store = fakeStore(['session_open'], { session_open: [{ type: 'user.message' }] })
    const createStore = vi.fn(() => store)

    await bootstrap(mockApp as never, createStore, undefined, undefined, undefined, () =>
      fakeSettings(),
    )

    expect(store.append).toHaveBeenCalledWith('session.idle', { sessionId: 'session_open' })
  })

  it('leaves an already-idle open session alone across a restart', async () => {
    const store = fakeStore(['session_idle'], { session_idle: [{ type: 'session.idle' }] })
    const createStore = vi.fn(() => store)

    await bootstrap(mockApp as never, createStore, undefined, undefined, undefined, () =>
      fakeSettings(),
    )

    expect(store.append).not.toHaveBeenCalledWith('session.idle', { sessionId: 'session_idle' })
  })

  it('defaults to the real electron app and file-backed stores', async () => {
    const store = await bootstrap()

    try {
      expect(store).toBeInstanceOf(EventStore)
      expect(store.count()).toBe(1)
      expect(store.list()[0]?.type).toBe('app.started')
    } finally {
      store.close()
    }
  })

  it('replays a fixture into in-memory stores when AGENTINATOR_REPLAY is set', async () => {
    const store = fakeStore()
    const createStore = vi.fn(() => store)
    const createSettings = vi.fn(() => fakeSettings())
    const replay = vi.fn(() => Promise.resolve())

    await bootstrap(
      mockApp as never,
      createStore,
      undefined,
      { AGENTINATOR_REPLAY: 'fixtures/demo.json' },
      replay,
      createSettings,
    )

    expect(createStore).toHaveBeenCalledWith(':memory:')
    expect(createSettings).toHaveBeenCalledWith(':memory:')
    expect(replay).toHaveBeenCalledWith('fixtures/demo.json', store, broadcastEvent)
  })

  it('reads the session budget from settings when a demo session starts', async () => {
    const settings = fakeSettings()
    await bootstrap(
      mockApp as never,
      (path) => new EventStore(path),
      undefined,
      undefined,
      undefined,
      () => settings,
    )

    const startDemo = mockIpcMain.handle.mock.calls.find(
      ([channel]) => channel === 'agent:start-demo',
    )?.[1] as (event: unknown) => string
    const cancel = mockIpcMain.handle.mock.calls.find(
      ([channel]) => channel === 'agent:cancel',
    )?.[1] as (event: unknown, sessionId: string) => Promise<void>

    const sessionId = startDemo(undefined)
    expect(settings.budgets).toHaveBeenCalled()
    await cancel(undefined, sessionId) // stop the scripted session's timers
  })

  it('consults the run-on-API-key toggle when a session starts', async () => {
    const settings = fakeSettings()
    ;(settings.apiKeyMode as ReturnType<typeof vi.fn>).mockReturnValue(true)
    await bootstrap(
      mockApp as never,
      (path) => new EventStore(path),
      undefined,
      undefined,
      undefined,
      () => settings,
    )

    const startDemo = mockIpcMain.handle.mock.calls.find(
      ([channel]) => channel === 'agent:start-demo',
    )?.[1] as (event: unknown) => string
    const cancel = mockIpcMain.handle.mock.calls.find(
      ([channel]) => channel === 'agent:cancel',
    )?.[1] as (event: unknown, sessionId: string) => Promise<void>

    const sessionId = startDemo(undefined)
    expect(settings.apiKeyMode).toHaveBeenCalled() // the resolveApiKey path ran
    await cancel(undefined, sessionId)
  })

  it('registers the e2e provider and routes tasks to it under AGENTINATOR_MOCK_TASKS', async () => {
    vi.stubEnv('AGENTINATOR_MOCK_TASKS', '1')
    const store = await bootstrap(
      mockApp as never,
      (path) => new EventStore(path),
      undefined,
      undefined,
      undefined,
      () => fakeSettings(),
    )

    try {
      const current = mockIpcMain.handle.mock.calls.find(
        ([channel]) => channel === 'agent:current',
      )?.[1] as (event: unknown) => unknown
      expect(current(undefined)).toEqual({ providerId: 'e2e', label: 'E2E' })
    } finally {
      store.close()
    }
  })

  it('quits the app when the last window closes, on every platform', async () => {
    await bootstrap(
      mockApp as never,
      () => fakeStore(),
      undefined,
      undefined,
      undefined,
      () => fakeSettings(),
    )

    const call = mockApp.on.mock.calls.find(([event]) => event === 'window-all-closed')
    const handler = call?.[1] as () => void
    handler()

    expect(mockApp.quit).toHaveBeenCalledOnce()
  })
})
