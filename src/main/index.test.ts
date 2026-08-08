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

import { bootstrap, createWindow, handleActivate, handleWindowAllClosed } from './index'

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

describe('handleActivate', () => {
  it('creates a window when none are open', () => {
    MockBrowserWindow.getAllWindows.mockReturnValue([])

    handleActivate()

    expect(MockBrowserWindow.instances).toHaveLength(1)
  })

  it('does nothing when a window is already open', () => {
    MockBrowserWindow.getAllWindows.mockReturnValue([new MockBrowserWindow({}) as unknown as never])
    MockBrowserWindow.instances = []

    handleActivate()

    expect(MockBrowserWindow.instances).toHaveLength(0)
  })
})

describe('handleWindowAllClosed', () => {
  it('quits on non-mac platforms', () => {
    const quit = vi.fn()

    handleWindowAllClosed(quit, 'linux')

    expect(quit).toHaveBeenCalledOnce()
  })

  it('stays running on macOS', () => {
    const quit = vi.fn()

    handleWindowAllClosed(quit, 'darwin')

    expect(quit).not.toHaveBeenCalled()
  })
})

describe('bootstrap', () => {
  it('waits for readiness, opens the first window, and registers lifecycle handlers', async () => {
    await bootstrap()

    expect(mockApp.whenReady).toHaveBeenCalledOnce()
    expect(MockBrowserWindow.instances).toHaveLength(1)
    expect(mockApp.on).toHaveBeenCalledWith('activate', handleActivate)
    expect(mockApp.on).toHaveBeenCalledWith('window-all-closed', expect.any(Function))
  })

  it('quits via the app when the registered window-all-closed handler fires off-mac', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      await bootstrap()

      const call = mockApp.on.mock.calls.find(([event]) => event === 'window-all-closed')
      const handler = call?.[1] as () => void
      handler()

      expect(mockApp.quit).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'platform', realPlatform as PropertyDescriptor)
    }
  })
})
