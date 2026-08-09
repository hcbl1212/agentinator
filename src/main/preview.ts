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
    return ref
  }

  /** A captured screenshot's PNG as base64 for the renderer, or null if gone. */
  image(ref: string): string | null {
    const bytes = this.#artifacts.read(ref)
    return bytes === undefined ? null : Buffer.from(bytes).toString('base64')
  }
}
