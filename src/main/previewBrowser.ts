import { BrowserWindow } from 'electron'

import type { ConsoleEntry, NetworkEntry } from '../shared/events'

/** A rendered screenshot of a target page: PNG bytes, pixel dimensions, and the
 * console output + network requests captured while it loaded. */
export interface Screenshot {
  png: Uint8Array
  width: number
  height: number
  console: ConsoleEntry[]
  network: NetworkEntry[]
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

/** Cap on captured entries so a chatty page can't bloat the event log. */
const MAX_ENTRIES = 100

/**
 * Captures via a hidden Electron BrowserWindow — Chromium ships with the app,
 * so there's no extra browser to bundle. Each capture is a throwaway window on
 * its own session partition, so console and network are scoped to just this
 * load and concurrent captures never share state. A load failure is caught and
 * recorded as a console error, then a (blank) shot is still returned — so the
 * agent sees "blank screen + here's why" rather than an opaque tool error.
 */
export class ElectronPreviewBrowser implements PreviewBrowser {
  async capture(target: string): Promise<Screenshot> {
    const partition = `preview-${crypto.randomUUID()}`
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { partition },
    })
    const messages: ConsoleEntry[] = []
    const network: NetworkEntry[] = []
    window.webContents.on('console-message', (details) => {
      messages.push({ level: details.level, text: details.message })
    })
    const webRequest = window.webContents.session.webRequest
    webRequest.onCompleted((details) => {
      network.push({
        method: details.method,
        url: details.url,
        status: details.statusCode,
        ok: details.statusCode < 400,
      })
    })
    webRequest.onErrorOccurred((details) => {
      network.push({ method: details.method, url: details.url, status: 0, ok: false })
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
      // Cap on return so a chatty page can't bloat the event log.
      return {
        png: image.toPNG(),
        width,
        height,
        console: messages.slice(0, MAX_ENTRIES),
        network: network.slice(0, MAX_ENTRIES),
      }
    } finally {
      window.destroy()
    }
  }
}
