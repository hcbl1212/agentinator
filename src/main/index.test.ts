import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EventStore } from './eventStore'

const { mockApp, MockBrowserWindow, mockShell, mockIpcMain, userData } = vi.hoisted(() => {
  type WindowOpenHandler = (details: { url: string }) => { action: 'deny' }

  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []
    static getAllWindows = vi.fn((): MockBrowserWindow[] => [])
    options: Record<string, unknown>
    loadFile = vi.fn()
    loadURL = vi.fn()
    windowOpenHandler: WindowOpenHandler | undefined
    webContents = {
      setWindowOpenHandler: (handler: WindowOpenHandler): void => {
        this.windowOpenHandler = handler
      },
    }

    constructor(options: Record<string, unknown>) {
      this.options = options
      MockBrowserWindow.instances.push(this)
    }
  }

  // The import-time bootstrap() writes a real event-log file. getPath reads
  // this holder lazily — the test module body fills it with a temp dir before
  // bootstrap's post-whenReady continuation runs (module evaluation finishes
  // ahead of microtasks), so tests never touch a real userData directory.
  const userData = { dir: '' }

  return {
    userData,
    MockBrowserWindow,
    mockApp: {
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      quit: vi.fn(),
      getPath: vi.fn(() => userData.dir),
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

userData.dir = mkdtempSync(join(tmpdir(), 'agentinator-test-'))

import { bootstrap, createWindow, registerEventIpc } from './index'

function fakeStore(): EventStore {
  return {
    append: vi.fn(),
    count: vi.fn(() => 42),
    list: vi.fn(() => []),
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
  })

  it('registers on ipcMain by default', () => {
    registerEventIpc(fakeStore())

    const channels = mockIpcMain.handle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual(['events:count', 'events:list'])
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
    expect(returned).toBe(store)
    expect(MockBrowserWindow.instances).toHaveLength(1)
  })

  it('quits the app when the last window closes, on every platform', async () => {
    await bootstrap(mockApp as never, fakeStore)

    const call = mockApp.on.mock.calls.find(([event]) => event === 'window-all-closed')
    const handler = call?.[1] as () => void
    handler()

    expect(mockApp.quit).toHaveBeenCalledOnce()
  })
})
