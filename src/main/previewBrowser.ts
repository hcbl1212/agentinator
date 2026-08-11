import { BrowserWindow } from 'electron'

import type { ConsoleEntry, NetworkEntry } from '../shared/events'
import { DEFAULT_SETTLE_MS } from '../shared/preview'

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
  /** Load a target (http(s) URL or a local file path) and capture it, pausing
   * `settleMs` after load so async data/console/network settle first. */
  capture(target: string, settleMs?: number): Promise<Screenshot>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Cap on captured entries so a chatty page can't bloat the event log. */
const MAX_ENTRIES = 100

/** A pause after load so console/network events (delivered a tick after they
 * fire) and async page data are all in before the shot — otherwise the capture
 * races them. Duration is caller-supplied (user-configurable per workspace). */
export const settleDelay = (ms: number = DEFAULT_SETTLE_MS): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Fixed short pause between capturePage retries (compositor warm-up), separate
 * from the configurable post-load settle. */
const RETRY_SETTLE_MS = 200

/**
 * Captures via a hidden Electron BrowserWindow — Chromium ships with the app,
 * so there's no extra browser to bundle. Each capture is a throwaway window on
 * its own session partition, so console and network are scoped to just this
 * load and concurrent captures never share state. A load failure is caught and
 * recorded as a console error, then a (blank) shot is still returned — so the
 * agent sees "blank screen + here's why" rather than an opaque tool error.
 */
/** The minimal shape of the NativeImage capturePage returns — kept structural so
 * tests can supply a fake without constructing a real Electron image. */
interface CapturedImage {
  getSize(): { width: number; height: number }
  toPNG(): Buffer
}

export class ElectronPreviewBrowser implements PreviewBrowser {
  #settle: (ms: number) => Promise<void>

  constructor(settle: (ms: number) => Promise<void> = settleDelay) {
    this.#settle = settle
  }

  /** capturePage intermittently rejects (e.g. UnknownVizError) when the Viz
   * compositor hasn't produced a frame yet — common on a hidden window over a
   * near-empty page. Settle and retry a couple times before giving up. */
  async #captureFrame(webContents: {
    capturePage(): Promise<CapturedImage>
  }): Promise<CapturedImage> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await webContents.capturePage()
      } catch (error) {
        if (attempt >= 2) {
          throw error
        }
        await this.#settle(RETRY_SETTLE_MS)
      }
    }
  }

  async capture(target: string, settleMs: number = DEFAULT_SETTLE_MS): Promise<Screenshot> {
    const partition = `preview-${crypto.randomUUID()}`
    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      // Opaque backing — a transparent/black default can leave the compositor
      // with no frame to hand capturePage on a sparse page.
      backgroundColor: '#ffffff',
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
      await this.#settle(settleMs)
      const image = await this.#captureFrame(window.webContents)
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
