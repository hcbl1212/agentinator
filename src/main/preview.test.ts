import { describe, expect, it, vi } from 'vitest'

import type { ArtifactStore } from './artifacts'
import { PreviewController } from './preview'
import type { PreviewBrowser, Screenshot } from './previewBrowser'

const SAMPLE = '/app/examples/sample-web/index.html'

function setup(
  shot: Screenshot = {
    png: new Uint8Array([1, 2, 3]),
    width: 800,
    height: 600,
    console: [{ level: 'warning', text: 'heads up' }],
    network: [{ method: 'GET', url: '/api/ok', status: 200, ok: true }],
  },
  target: string = SAMPLE,
): {
  controller: PreviewController
  browser: { capture: ReturnType<typeof vi.fn> }
  store: Map<string, Uint8Array>
  emit: ReturnType<typeof vi.fn>
} {
  const store = new Map<string, Uint8Array>()
  let n = 0
  const artifacts: ArtifactStore = {
    put: (bytes) => {
      const ref = `shot_${(n += 1)}`
      store.set(ref, bytes)
      return ref
    },
    read: (ref) => store.get(ref),
  }
  const browser: { capture: ReturnType<typeof vi.fn> } = {
    capture: vi.fn(() => Promise.resolve(shot)),
  }
  const emit = vi.fn((type: string, payload: unknown) => ({ seq: 1, ts: 't', type, payload }))
  const controller = new PreviewController(
    browser as unknown as PreviewBrowser,
    artifacts,
    emit as never,
    () => target,
  )
  return { controller, browser, store, emit }
}

describe('PreviewController', () => {
  it('captures the default sample when no url is given and logs a lean event', async () => {
    const { controller, browser, store, emit } = setup()

    const ref = await controller.capture('session_1')

    expect(browser.capture).toHaveBeenCalledWith(SAMPLE)
    expect(store.get(ref)).toEqual(new Uint8Array([1, 2, 3]))
    expect(emit).toHaveBeenCalledWith('preview.captured', {
      sessionId: 'session_1',
      ref,
      url: SAMPLE,
      width: 800,
      height: 600,
      console: [{ level: 'warning', text: 'heads up' }],
      network: [{ method: 'GET', url: '/api/ok', status: 200, ok: true }],
    })
  })

  it('captures the configured target when one is set', async () => {
    const { controller, browser, emit } = setup(undefined, 'http://localhost:3001/')

    await controller.capture('session_1')

    expect(browser.capture).toHaveBeenCalledWith('http://localhost:3001/')
    expect(emit).toHaveBeenCalledWith(
      'preview.captured',
      expect.objectContaining({ url: 'http://localhost:3001/' }),
    )
  })

  it('captures an explicit url when one is provided', async () => {
    const { controller, browser } = setup()

    await controller.capture('session_1', 'http://localhost:5173/')

    expect(browser.capture).toHaveBeenCalledWith('http://localhost:5173/')
  })

  it('captures for the agent, returning base64 PNG and still logging the event', async () => {
    const { controller, browser, emit } = setup({
      png: new Uint8Array([10, 20, 30]),
      width: 640,
      height: 480,
      console: [{ level: 'error', text: 'boom' }],
      network: [{ method: 'POST', url: '/api/cart', status: 500, ok: false }],
    })

    const image = await controller.captureImage('session_1')

    expect(browser.capture).toHaveBeenCalledWith(SAMPLE)
    expect(image).toEqual({
      base64: Buffer.from([10, 20, 30]).toString('base64'),
      mediaType: 'image/png',
      console: [{ level: 'error', text: 'boom' }],
      network: [{ method: 'POST', url: '/api/cart', status: 500, ok: false }],
    })
    // The agent capture still surfaces in the pane/timeline like a manual one.
    expect(emit).toHaveBeenCalledWith(
      'preview.captured',
      expect.objectContaining({ sessionId: 'session_1' }),
    )
  })

  it('reads a captured screenshot back as base64', async () => {
    const { controller } = setup({
      png: new Uint8Array([255, 0, 128]),
      width: 1,
      height: 1,
      console: [],
      network: [],
    })

    const ref = await controller.capture('session_1')

    expect(controller.image(ref)).toBe(Buffer.from([255, 0, 128]).toString('base64'))
  })

  it('returns null when the ref is unknown', () => {
    const { controller } = setup()

    expect(controller.image('shot_missing')).toBeNull()
  })
})
