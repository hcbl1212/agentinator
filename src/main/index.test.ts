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
  registerAgentIpc,
  registerEventIpc,
} from './index'
import type { SessionManager } from './sessions'

// index.ts has no import-time side effects (see entry.ts), so this runs
// before any code can open a store: every getPath call lands in a temp dir.
mockApp.getPath.mockReturnValue(mkdtempSync(join(tmpdir(), 'agentinator-test-')))

function fakeStore(): EventStore {
  return {
    append: vi.fn(),
    count: vi.fn(() => 42),
    list: vi.fn(() => []),
    tail: vi.fn(() => []),
    close: vi.fn(),
  } as unknown as EventStore
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
    handlers.get('events:list')?.(undefined, 5)
    expect(store.list).toHaveBeenCalledWith(5)
    handlers.get('events:tail')?.(undefined, 100, 7)
    expect(store.tail).toHaveBeenCalledWith(100, 7)
  })

  it('registers on ipcMain by default', () => {
    registerEventIpc(fakeStore())

    const channels = mockIpcMain.handle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual(['events:count', 'events:list', 'events:tail'])
  })
})

describe('registerAgentIpc', () => {
  function fakeManager(): { start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
    return { start: vi.fn(() => 'session_new'), cancel: vi.fn(() => Promise.resolve()) }
  }

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
    expect(channels).toEqual(['agent:start-demo', 'agent:cancel'])
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
  it('opens the store in userData, records app.started, and serves IPC', async () => {
    const store = fakeStore()
    const createStore = vi.fn(() => store)

    const returned = await bootstrap(mockApp as never, createStore)

    expect(createStore).toHaveBeenCalledWith(expect.stringContaining('agentinator.db'))
    expect(store.append).toHaveBeenCalledWith('app.started', { version: '0.1.0-test' })
    expect(mockIpcMain.handle).toHaveBeenCalledWith('events:count', expect.any(Function))
    expect(mockIpcMain.handle).toHaveBeenCalledWith('agent:start-demo', expect.any(Function))
    expect(returned).toBe(store)
    expect(MockBrowserWindow.instances).toHaveLength(1)
  })

  it('defaults to the real electron app and a file-backed store', async () => {
    const store = await bootstrap()

    try {
      expect(store).toBeInstanceOf(EventStore)
      expect(store.count()).toBe(1)
      expect(store.list()[0]?.type).toBe('app.started')
    } finally {
      store.close()
    }
  })

  it('replays a fixture into an in-memory store when AGENTINATOR_REPLAY is set', async () => {
    const store = fakeStore()
    const createStore = vi.fn(() => store)
    const replay = vi.fn(() => Promise.resolve())

    await bootstrap(
      mockApp as never,
      createStore,
      undefined,
      { AGENTINATOR_REPLAY: 'fixtures/demo.json' },
      replay,
    )

    expect(createStore).toHaveBeenCalledWith(':memory:')
    expect(replay).toHaveBeenCalledWith('fixtures/demo.json', store, broadcastEvent)
  })

  it('quits the app when the last window closes, on every platform', async () => {
    await bootstrap(mockApp as never, fakeStore)

    const call = mockApp.on.mock.calls.find(([event]) => event === 'window-all-closed')
    const handler = call?.[1] as () => void
    handler()

    expect(mockApp.quit).toHaveBeenCalledOnce()
  })
})
