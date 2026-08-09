import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EventStore } from './eventStore'

const { mockApp, MockBrowserWindow, mockShell, mockIpcMain } = vi.hoisted(() => {
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

  return {
    MockBrowserWindow,
    mockApp: {
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      quit: vi.fn(),
      getPath: vi.fn(),
      getVersion: vi.fn(() => '0.1.0-test'),
    },
    mockShell: { openExternal: vi.fn(() => Promise.resolve()) },
    mockIpcMain: { handle: vi.fn() },
  }
})

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: MockBrowserWindow,
  shell: mockShell,
  ipcMain: mockIpcMain,
}))

// The SDK spawns a CLI when queried; tests must never construct the real one.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))

import type { StoredEvent } from '../shared/events'
import {
  bootstrap,
  broadcastEvent,
  createWindow,
  makeEmitStored,
  registerAgentIpc,
  registerApprovalIpc,
  registerEventIpc,
  registerSettingsIpc,
  taskTitle,
} from './index'
import type { SessionManager } from './sessions'
import type { SettingsStore } from './settingsStore'

// index.ts has no import-time side effects (see entry.ts), so this runs
// before any code can open a store: every getPath call lands in a temp dir.
mockApp.getPath.mockReturnValue(mkdtempSync(join(tmpdir(), 'agentinator-test-')))

function fakeStore(openSessions: string[] = []): EventStore {
  return {
    append: vi.fn(),
    count: vi.fn(() => 42),
    totalCostUsd: vi.fn(() => 1.5),
    latestDiffs: vi.fn(() => []),
    list: vi.fn(() => []),
    tail: vi.fn(() => []),
    search: vi.fn(() => []),
    openSessionIds: vi.fn(() => openSessions),
    close: vi.fn(),
  } as unknown as EventStore
}

function fakeSettings(): SettingsStore {
  return {
    budgets: vi.fn(() => ({ session: 5, hour: null, day: null, week: null, month: null })),
    setBudget: vi.fn(),
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

    const channels = mockIpcMain.handle.mock.calls.map(([channel]) => channel)
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
    describeProvider: ReturnType<typeof vi.fn>
  } {
    return {
      start: vi.fn(() => 'session_new'),
      send: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(() => Promise.resolve()),
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

    const channels = mockIpcMain.handle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual([
      'agent:current',
      'agent:start-demo',
      'agent:start-task',
      'agent:send',
      'agent:cancel',
    ])
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
    const settings = { budgets: vi.fn(() => budgets), setBudget: vi.fn() }
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerSettingsIpc(settings as unknown as SettingsStore, (channel, listener) => {
      handlers.set(channel, listener)
    })

    expect(handlers.get('settings:get-budgets')?.(undefined)).toBe(budgets)
    handlers.get('settings:set-budget')?.(undefined, 'day', 12)
    expect(settings.setBudget).toHaveBeenCalledWith('day', 12)
  })

  it('registers on ipcMain by default', () => {
    registerSettingsIpc(fakeSettings())

    const channels = mockIpcMain.handle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual(['settings:get-budgets', 'settings:set-budget'])
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

    const channels = mockIpcMain.handle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual(['approvals:pending', 'approvals:resolve', 'approvals:undo'])
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

  it('closes sessions left open by a previous run so they are not zombies', async () => {
    const store = fakeStore(['session_zombie'])
    const createStore = vi.fn(() => store)

    await bootstrap(mockApp as never, createStore, undefined, undefined, undefined, () =>
      fakeSettings(),
    )

    expect(store.append).toHaveBeenCalledWith('session.ended', {
      sessionId: 'session_zombie',
      outcome: 'failed',
    })
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
