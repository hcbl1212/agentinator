import type { ConsoleEntry, NetworkEntry } from '../shared/events'
import type { EmitStored } from './approvals'
import type { ArtifactStore } from './artifacts'
import type { PreviewBrowser } from './previewBrowser'

/**
 * The visual feedback loop's main-process brain: capture the target app, stash
 * the PNG in the artifact store, and record a lean `preview.captured` event.
 * Screenshot bytes never enter the event log — the renderer reads them back by
 * ref. Vendor-neutral: it drives a PreviewBrowser and knows nothing of the
 * agent provider.
 */
export class PreviewController {
  #browser: PreviewBrowser
  #artifacts: ArtifactStore
  #emit: EmitStored
  #resolveTarget: () => string

  constructor(
    browser: PreviewBrowser,
    artifacts: ArtifactStore,
    emit: EmitStored,
    // Resolved per capture so a changed target (a real dev-server URL) takes
    // effect immediately; falls back to the bundled sample.
    resolveTarget: () => string,
  ) {
    this.#browser = browser
    this.#artifacts = artifacts
    this.#emit = emit
    this.#resolveTarget = resolveTarget
  }

  /** Capture a target (the configured one when none is given) for a session,
   * returning the artifact ref. */
  async capture(sessionId: string, url?: string): Promise<string> {
    return (await this.#snap(sessionId, url)).ref
  }

  /** Capture for the agent: the same screenshot plus the page's console output
   * and network requests, so the model sees runtime errors as well as pixels.
   * Still surfaces in the pane like a manual capture. */
  async captureImage(
    sessionId: string,
    url?: string,
  ): Promise<{
    base64: string
    mediaType: string
    console: ConsoleEntry[]
    network: NetworkEntry[]
  }> {
    const { base64, console, network } = await this.#snap(sessionId, url)
    return { base64, mediaType: 'image/png', console, network }
  }

  /** Take one screenshot: store it, log a lean event (with console + network),
   * and hand back the ref, bytes, console, and network for whoever asked. */
  async #snap(
    sessionId: string,
    url?: string,
  ): Promise<{
    ref: string
    base64: string
    console: ConsoleEntry[]
    network: NetworkEntry[]
  }> {
    const target = url ?? this.#resolveTarget()
    const shot = await this.#browser.capture(target)
    const ref = this.#artifacts.put(shot.png)
    this.#emit('preview.captured', {
      sessionId,
      ref,
      url: target,
      width: shot.width,
      height: shot.height,
      console: shot.console,
      network: shot.network,
    })
    return {
      ref,
      base64: Buffer.from(shot.png).toString('base64'),
      console: shot.console,
      network: shot.network,
    }
  }

  /** A captured screenshot's PNG as base64 for the renderer, or null if gone. */
  image(ref: string): string | null {
    const bytes = this.#artifacts.read(ref)
    return bytes === undefined ? null : Buffer.from(bytes).toString('base64')
  }
}
