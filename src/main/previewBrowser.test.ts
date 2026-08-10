import { beforeEach, describe, expect, it, vi } from 'vitest'

const { MockBrowserWindow, capturePage } = vi.hoisted(() => {
  const image = {
    getSize: vi.fn(() => ({ width: 1280, height: 800 })),
    toPNG: vi.fn(() => Buffer.from([137, 80, 78, 71])),
  }
  const capturePage = vi.fn(() => Promise.resolve(image))

  type ConsoleListener = (details: { level: string; message: string }) => void
  type CompletedListener = (details: { method: string; url: string; statusCode: number }) => void
  type ErrorListener = (details: { method: string; url: string; error: string }) => void

  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []
    // When set, the next load() rejects with this value instead of resolving.
    static loadRejection: { value: unknown } | null = null
    consoleListener: ConsoleListener | undefined
    completedListener: CompletedListener | undefined
    errorListener: ErrorListener | undefined

    #load = (level: 'warning' | 'info', message: string): Promise<void> => {
      if (MockBrowserWindow.loadRejection !== null) {
        // Intentionally rejects with arbitrary values (incl. non-Errors) to
        // exercise the adapter's load-failure handling.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(MockBrowserWindow.loadRejection.value)
      }
      // A real page emits console + network during load.
      this.consoleListener?.({ level, message })
      this.completedListener?.({
        method: 'GET',
        url: 'http://localhost:3001/api/ok',
        statusCode: 200,
      })
      this.completedListener?.({
        method: 'GET',
        url: 'http://localhost:4001/api/cart',
        statusCode: 500,
      })
      this.errorListener?.({ method: 'GET', url: 'http://localhost:4001/down', error: 'net::ERR' })
      return Promise.resolve()
    }
    loadURL = vi.fn(() => this.#load('warning', 'from url'))
    loadFile = vi.fn(() => this.#load('info', 'from file'))
    destroy = vi.fn()
    webContents = {
      capturePage,
      on: (event: string, listener: ConsoleListener): void => {
        if (event === 'console-message') {
          this.consoleListener = listener
        }
      },
      session: {
        webRequest: {
          onCompleted: (listener: CompletedListener): void => {
            this.completedListener = listener
          },
          onErrorOccurred: (listener: ErrorListener): void => {
            this.errorListener = listener
          },
        },
      },
    }

    constructor(public options: Record<string, unknown>) {
      MockBrowserWindow.instances.push(this)
    }
  }

  return { MockBrowserWindow, capturePage }
})

vi.mock('electron', () => ({ BrowserWindow: MockBrowserWindow }))

import { ElectronPreviewBrowser, settleDelay } from './previewBrowser'

// Inject a no-op settle so the real 200ms pause doesn't slow the unit tests.
const mk = (): ElectronPreviewBrowser => new ElectronPreviewBrowser(() => Promise.resolve())

beforeEach(() => {
  vi.clearAllMocks()
  MockBrowserWindow.instances = []
  MockBrowserWindow.loadRejection = null
})

describe('ElectronPreviewBrowser', () => {
  it('loads an http URL, captures the page, and returns PNG + size + console', async () => {
    const shot = await mk().capture('http://localhost:5173/')

    const window = MockBrowserWindow.instances[0]
    expect(window?.options).toMatchObject({ show: false })
    const webPreferences = window?.options.webPreferences as { partition: string } | undefined
    expect(webPreferences?.partition).toMatch(/^preview-/)
    expect(window?.loadURL).toHaveBeenCalledWith('http://localhost:5173/')
    expect(window?.loadFile).not.toHaveBeenCalled()
    expect(shot).toEqual({
      png: Buffer.from([137, 80, 78, 71]),
      width: 1280,
      height: 800,
      console: [{ level: 'warning', text: 'from url' }],
      network: [
        { method: 'GET', url: 'http://localhost:3001/api/ok', status: 200, ok: true },
        { method: 'GET', url: 'http://localhost:4001/api/cart', status: 500, ok: false },
        { method: 'GET', url: 'http://localhost:4001/down', status: 0, ok: false },
      ],
    })
    expect(window?.destroy).toHaveBeenCalledOnce()
  })

  it('loads a local file path when the target is not an http URL', async () => {
    const shot = await mk().capture('/app/examples/sample-web/index.html')

    const window = MockBrowserWindow.instances[0]
    expect(window?.loadFile).toHaveBeenCalledWith('/app/examples/sample-web/index.html')
    expect(window?.loadURL).not.toHaveBeenCalled()
    expect(shot.console).toEqual([{ level: 'info', text: 'from file' }])
  })

  it('records a load failure as a console error and still returns a shot', async () => {
    MockBrowserWindow.loadRejection = { value: new Error('ERR_CONNECTION_REFUSED') }

    const shot = await mk().capture('http://localhost:9/')

    expect(shot.console).toEqual([
      { level: 'error', text: 'Failed to load http://localhost:9/: ERR_CONNECTION_REFUSED' },
    ])
    expect(shot.png).toEqual(Buffer.from([137, 80, 78, 71]))
    expect(MockBrowserWindow.instances[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('stringifies a non-Error load rejection', async () => {
    MockBrowserWindow.loadRejection = { value: 'boom' }

    const shot = await mk().capture('http://x/')

    expect(shot.console).toEqual([{ level: 'error', text: 'Failed to load http://x/: boom' }])
  })

  it('destroys the window even when the capture fails', async () => {
    capturePage.mockRejectedValueOnce(new Error('render crashed'))

    await expect(mk().capture('http://x/')).rejects.toThrow('render crashed')
    expect(MockBrowserWindow.instances[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('settles before capturing so console/network events aren’t raced', async () => {
    vi.useFakeTimers()
    try {
      const settled = settleDelay()
      let done = false
      void settled.then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(200)
      await settled
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
