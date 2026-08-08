import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApp, MockBrowserWindow, mockShell } = vi.hoisted(() => {
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

  return {
    MockBrowserWindow,
    mockApp: {
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      quit: vi.fn(),
    },
    mockShell: { openExternal: vi.fn(() => Promise.resolve()) },
  }
})

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: MockBrowserWindow,
  shell: mockShell,
}))

import { bootstrap, createWindow } from './index'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  MockBrowserWindow.instances = []
  MockBrowserWindow.getAllWindows.mockReturnValue([])
})

describe('createWindow', () => {
  it('creates a window titled Agentinator with secure web preferences', () => {
    const window = createWindow() as unknown as InstanceType<typeof MockBrowserWindow>

    expect(window.options['title']).toBe('Agentinator')
    expect(window.options['webPreferences']).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

describe('bootstrap', () => {
  it('waits for readiness, opens the first window, and registers the close handler', async () => {
    await bootstrap()

    expect(mockApp.whenReady).toHaveBeenCalledOnce()
    expect(MockBrowserWindow.instances).toHaveLength(1)
    expect(mockApp.on).toHaveBeenCalledWith('window-all-closed', expect.any(Function))
  })

  it('quits the app when the last window closes, on every platform', async () => {
    await bootstrap()

    const call = mockApp.on.mock.calls.find(([event]) => event === 'window-all-closed')
    const handler = call?.[1] as () => void
    handler()

    expect(mockApp.quit).toHaveBeenCalledOnce()
  })
})
