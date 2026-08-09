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
  #defaultTarget: string

  constructor(
    browser: PreviewBrowser,
    artifacts: ArtifactStore,
    emit: EmitStored,
    defaultTarget: string,
  ) {
    this.#browser = browser
    this.#artifacts = artifacts
    this.#emit = emit
    this.#defaultTarget = defaultTarget
  }

  /** Capture a target (the bundled sample when none is given) for a session,
   * returning the artifact ref. */
  async capture(sessionId: string, url?: string): Promise<string> {
    return (await this.#snap(sessionId, url)).ref
  }

  /** Capture for the agent: the same screenshot, returned as a base64 image the
   * provider can hand to the model, while still surfacing in the pane. */
  async captureImage(
    sessionId: string,
    url?: string,
  ): Promise<{ base64: string; mediaType: string }> {
    const { base64 } = await this.#snap(sessionId, url)
    return { base64, mediaType: 'image/png' }
  }

  /** Take one screenshot: store it, log a lean event, and hand back the ref and
   * bytes for whoever asked (the UI needs the ref, the agent needs the bytes). */
  async #snap(sessionId: string, url?: string): Promise<{ ref: string; base64: string }> {
    const target = url ?? this.#defaultTarget
    const shot = await this.#browser.capture(target)
    const ref = this.#artifacts.put(shot.png)
    this.#emit('preview.captured', {
      sessionId,
      ref,
      url: target,
      width: shot.width,
      height: shot.height,
    })
    return { ref, base64: Buffer.from(shot.png).toString('base64') }
  }

  /** A captured screenshot's PNG as base64 for the renderer, or null if gone. */
  image(ref: string): string | null {
    const bytes = this.#artifacts.read(ref)
    return bytes === undefined ? null : Buffer.from(bytes).toString('base64')
  }
}
