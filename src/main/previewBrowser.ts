import { BrowserWindow } from 'electron'

import type { ConsoleEntry } from '../shared/events'

/** A rendered screenshot of a target page: PNG bytes, pixel dimensions, and the
 * console output captured while it loaded (including a load failure). */
export interface Screenshot {
  png: Uint8Array
  width: number
  height: number
  console: ConsoleEntry[]
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Captures via a hidden Electron BrowserWindow — Chromium ships with the app,
 * so there's no extra browser to bundle. Each capture is a throwaway window so
 * concurrent captures never share state. A load failure is caught and recorded
 * as a console error, then a (blank) shot is still returned — so the agent sees
 * "blank screen + here's why" rather than an opaque tool error.
 */
export class ElectronPreviewBrowser implements PreviewBrowser {
  async capture(target: string): Promise<Screenshot> {
    const window = new BrowserWindow({ show: false, width: 1280, height: 800 })
    const messages: ConsoleEntry[] = []
    window.webContents.on('console-message', (details) => {
      messages.push({ level: details.level, text: details.message })
    })
    try {
      try {
        if (/^https?:/i.test(target)) {
          await window.loadURL(target)
        } else {
          await window.loadFile(target)
        }
      } catch (error) {
        messages.push({ level: 'error', text: `Failed to load ${target}: ${errorMessage(error)}` })
      }
      const image = await window.webContents.capturePage()
      const { width, height } = image.getSize()
      return { png: image.toPNG(), width, height, console: messages }
    } finally {
      window.destroy()
    }
  }
}
