import { BrowserWindow } from 'electron'

/** A rendered screenshot of a target page: PNG bytes plus pixel dimensions. */
export interface Screenshot {
  png: Uint8Array
  width: number
  height: number
}

/**
 * Renders a target app off-screen and screenshots it — the harness's eyes on
 * the app an agent is building. An interface so the whole preview pipeline is
 * testable with a fake, and so the engine (Electron here, could be Playwright)
 * stays swappable behind one seam.
 */
export interface PreviewBrowser {
  /** Load a target (http(s) URL or a local file path) and capture it. */
  capture(target: string): Promise<Screenshot>
}

/**
 * Captures via a hidden Electron BrowserWindow — Chromium ships with the app,
 * so there's no extra browser to bundle. Each capture is a throwaway window so
 * concurrent captures never share state.
 */
export class ElectronPreviewBrowser implements PreviewBrowser {
  async capture(target: string): Promise<Screenshot> {
    const window = new BrowserWindow({ show: false, width: 1280, height: 800 })
    try {
      if (/^https?:/i.test(target)) {
        await window.loadURL(target)
      } else {
        await window.loadFile(target)
      }
      const image = await window.webContents.capturePage()
      const { width, height } = image.getSize()
      return { png: image.toPNG(), width, height }
    } finally {
      window.destroy()
    }
  }
}
