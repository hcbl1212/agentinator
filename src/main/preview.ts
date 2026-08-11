import type { ConsoleEntry, NetworkEntry } from '../shared/events'
import type { EmitStored } from './approvals'
import type { ArtifactStore } from './artifacts'
import type { ComponentWorkbench } from './componentWorkbench'
import type { PreviewBrowser } from './previewBrowser'

/** How the controller resolves what URL/file to capture, resolved fresh each
 * shot so a changed target/component takes effect immediately. */
export interface PreviewTargeting {
  /** The configured dev-server URL, or undefined for the bundled sample. */
  previewTarget: () => string | undefined
  /** A pinned component (app root + root-relative file, optional wrapper and
   * props literal), or undefined. */
  component: () => { root: string; file: string; wrapper?: string; props?: string } | undefined
  /** Writes the component entry and returns its dev-server path. */
  workbench: ComponentWorkbench
  /** The bundled sample, used when nothing else is configured. */
  sample: string
  /** How long to let the page settle after load before the shot, in ms. */
  settleMs: () => number
}

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
  #targeting: PreviewTargeting

  constructor(
    browser: PreviewBrowser,
    artifacts: ArtifactStore,
    emit: EmitStored,
    targeting: PreviewTargeting,
  ) {
    this.#browser = browser
    this.#artifacts = artifacts
    this.#emit = emit
    this.#targeting = targeting
  }

  /** What to capture, resolved per shot: a pinned component (rendered in
   * isolation through the dev server) wins; else the configured dev-server URL;
   * else the bundled sample. */
  #resolveTarget(): string {
    const { previewTarget, component, workbench, sample } = this.#targeting
    const base = previewTarget()
    const pinned = component()
    if (pinned !== undefined && base !== undefined) {
      const entry = workbench.prepare(pinned.root, pinned.file, pinned.wrapper, pinned.props)
      return `${base.replace(/\/$/, '')}${entry}`
    }
    return base ?? sample
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
    const shot = await this.#browser.capture(target, this.#targeting.settleMs())
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
