import { beforeEach, describe, expect, it, vi } from 'vitest'

const { MockBrowserWindow, capturePage } = vi.hoisted(() => {
  const image = {
    getSize: vi.fn(() => ({ width: 1280, height: 800 })),
    toPNG: vi.fn(() => Buffer.from([137, 80, 78, 71])),
  }
  const capturePage = vi.fn(() => Promise.resolve(image))

  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []
    loadURL = vi.fn(() => Promise.resolve())
    loadFile = vi.fn(() => Promise.resolve())
    destroy = vi.fn()
    webContents = { capturePage }

    constructor(public options: Record<string, unknown>) {
      MockBrowserWindow.instances.push(this)
    }
  }

  return { MockBrowserWindow, capturePage }
})

vi.mock('electron', () => ({ BrowserWindow: MockBrowserWindow }))

import { ElectronPreviewBrowser } from './previewBrowser'

beforeEach(() => {
  vi.clearAllMocks()
  MockBrowserWindow.instances = []
})

describe('ElectronPreviewBrowser', () => {
  it('loads an http URL, captures the page, and returns PNG + size', async () => {
    const shot = await new ElectronPreviewBrowser().capture('http://localhost:5173/')

    const window = MockBrowserWindow.instances[0]
    expect(window?.options).toMatchObject({ show: false })
    expect(window?.loadURL).toHaveBeenCalledWith('http://localhost:5173/')
    expect(window?.loadFile).not.toHaveBeenCalled()
    expect(shot).toEqual({ png: Buffer.from([137, 80, 78, 71]), width: 1280, height: 800 })
    expect(window?.destroy).toHaveBeenCalledOnce()
  })

  it('loads a local file path when the target is not an http URL', async () => {
    await new ElectronPreviewBrowser().capture('/app/examples/sample-web/index.html')

    const window = MockBrowserWindow.instances[0]
    expect(window?.loadFile).toHaveBeenCalledWith('/app/examples/sample-web/index.html')
    expect(window?.loadURL).not.toHaveBeenCalled()
  })

  it('destroys the window even when the capture fails', async () => {
    capturePage.mockRejectedValueOnce(new Error('render crashed'))

    await expect(new ElectronPreviewBrowser().capture('http://x/')).rejects.toThrow(
      'render crashed',
    )
    expect(MockBrowserWindow.instances[0]?.destroy).toHaveBeenCalledOnce()
  })
})
