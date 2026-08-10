// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { ConsoleEntry, NetworkEntry, StoredEvent } from '../../../shared/events'
import { Preview } from './Preview'

function captureEvent(
  sessionId: string,
  seq: number,
  ref = `shot_${seq}`,
  console: ConsoleEntry[] = [],
  network: NetworkEntry[] = [],
): StoredEvent {
  return {
    seq,
    ts: 't',
    type: 'preview.captured',
    payload: { sessionId, ref, url: 'file:///sample', width: 1280, height: 800, console, network },
  }
}

interface Stub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  image: ReturnType<typeof vi.fn>
  capture: ReturnType<typeof vi.fn>
  agentSend: ReturnType<typeof vi.fn>
  getPreviewTarget: ReturnType<typeof vi.fn>
  setPreviewTarget: ReturnType<typeof vi.fn>
  getComponent: ReturnType<typeof vi.fn>
  setComponent: ReturnType<typeof vi.fn>
  inferProps: ReturnType<typeof vi.fn>
  inferWrapper: ReturnType<typeof vi.fn>
  chooseFolder: ReturnType<typeof vi.fn>
  chooseFile: ReturnType<typeof vi.fn>
}

function stub(
  options: {
    captures?: StoredEvent[]
    image?: string | null
    target?: string | null
    component?: { root: string; file: string; wrapper?: string; props?: string } | null
    inferred?: string
    inferredWrapper?: string
    chosenFolder?: string | null
    chosenFile?: string | null
  } = {},
): Stub {
  const {
    captures = [],
    image = 'YWJj',
    target = null,
    component = null,
    inferred = '{ n: 1 }',
    inferredWrapper = '__agentinator_wrapper.tsx',
    chosenFolder = '/picked/app',
    chosenFile = 'src/Picked.tsx',
  } = options
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const search = vi.fn(() => Promise.resolve(captures))
  const imageFn = vi.fn(() => Promise.resolve(image))
  const capture = vi.fn(() => Promise.resolve('shot_new'))
  const agentSend = vi.fn(() => Promise.resolve())
  const getPreviewTarget = vi.fn(() => Promise.resolve(target))
  const setPreviewTarget = vi.fn(() => Promise.resolve())
  const getComponent = vi.fn(() => Promise.resolve(component))
  const setComponent = vi.fn(() => Promise.resolve())
  const inferProps = vi.fn(() => Promise.resolve(inferred))
  const inferWrapper = vi.fn(() => Promise.resolve(inferredWrapper))
  const chooseFolder = vi.fn(() => Promise.resolve(chosenFolder))
  const chooseFile = vi.fn(() => Promise.resolve(chosenFile))
  const bridge = {
    events: {
      search,
      onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
        appended = listener
        return unsubscribe as () => void
      }),
    },
    preview: {
      capture,
      image: imageFn,
      getComponent,
      setComponent,
      inferProps,
      inferWrapper,
      chooseFolder,
      chooseFile,
    },
    agent: { send: agentSend },
    settings: { getPreviewTarget, setPreviewTarget },
  } as unknown as AgentinatorBridge
  return {
    bridge,
    emit: (event) => appended?.(event),
    unsubscribe,
    search,
    image: imageFn,
    capture,
    agentSend,
    getPreviewTarget,
    setPreviewTarget,
    getComponent,
    setComponent,
    inferProps,
    inferWrapper,
    chooseFolder,
    chooseFile,
  }
}

/** Render, wait for the screenshot, then click it at a known spot (with a
 * stubbed geometry so jsdom's zero-size layout doesn't break the math). */
async function renderAndMark(stubbed: Stub): Promise<HTMLElement> {
  window.agentinator = stubbed.bridge
  render(<Preview sessionId="s" />)
  const frame = await screen.findByRole('button', { name: /Point at the app/i })
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect
  fireEvent.click(frame, { clientX: 100, clientY: 50 })
  return frame
}

afterEach(() => {
  delete window.agentinator
})

describe('Preview', () => {
  it('prompts to pick an agent when none is selected (null or undefined)', () => {
    const stubbed = stub()
    window.agentinator = stubbed.bridge

    const { rerender } = render(<Preview sessionId={null} />)
    expect(screen.getByText(/Select an agent to preview its app/)).toBeInTheDocument()

    rerender(<Preview sessionId={undefined} />)
    expect(screen.getByText(/Select an agent to preview its app/)).toBeInTheDocument()
    expect(stubbed.search).not.toHaveBeenCalled()
  })

  it('shows the capture prompt and no-ops the buttons without a bridge', () => {
    render(<Preview sessionId="s" />)

    expect(screen.getByText(/Capture a screenshot of the target app/)).toBeInTheDocument()
    // Clicking without a bridge must not throw — any control.
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    fireEvent.click(screen.getByRole('button', { name: 'Set' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    fireEvent.click(screen.getByRole('button', { name: 'Infer props' }))
    fireEvent.click(screen.getByRole('button', { name: 'Infer wrapper' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose app root' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose component file' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('button', { name: 'Capture' })).toBeEnabled()
  })

  it('picks the app root and files with the native dialogs', async () => {
    const stubbed = stub({ chosenFolder: '/picked/app', chosenFile: 'src/ui/Cart.tsx' })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose app root' }))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Component app root' })).toHaveValue(
        '/picked/app',
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choose component file' }))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Component file' })).toHaveValue(
        'src/ui/Cart.tsx',
      ),
    )
    // The file picker resolves relative to the chosen root.
    expect(stubbed.chooseFile).toHaveBeenCalledWith('/picked/app')

    fireEvent.click(screen.getByRole('button', { name: 'Choose wrapper file' }))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Wrapper file' })).toHaveValue('src/ui/Cart.tsx'),
    )
  })

  it('leaves fields unchanged when a picker is cancelled', async () => {
    const stubbed = stub({ chosenFolder: null, chosenFile: null })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose app root' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose component file' }))
    await waitFor(() => expect(stubbed.chooseFolder).toHaveBeenCalled())

    expect(screen.getByRole('textbox', { name: 'Component app root' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Component file' })).toHaveValue('')
  })

  it('loads, pins (with wrapper), and clears a component workbench target', async () => {
    const stubbed = stub({
      component: { root: '/app', file: 'src/Cart.tsx', wrapper: 'src/Providers.tsx' },
    })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    // The pinned component (and its wrapper) load into the inputs.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Component file' })).toHaveValue('src/Cart.tsx'),
    )
    expect(screen.getByRole('textbox', { name: 'Component app root' })).toHaveValue('/app')
    expect(screen.getByRole('textbox', { name: 'Wrapper file' })).toHaveValue('src/Providers.tsx')

    fireEvent.change(screen.getByRole('textbox', { name: 'Component file' }), {
      target: { value: 'src/Button.tsx' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Wrapper file' }), {
      target: { value: 'src/NewProviders.tsx' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    expect(stubbed.setComponent).toHaveBeenCalledWith(
      '/app',
      'src/Button.tsx',
      'src/NewProviders.tsx',
      null,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('textbox', { name: 'Component file' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Wrapper file' })).toHaveValue('')
    expect(stubbed.setComponent).toHaveBeenLastCalledWith('', null)
  })

  it('infers props via the agent and fills the props field, then pins them', async () => {
    const stubbed = stub({
      component: { root: '/app', file: 'src/Cart.tsx' },
      inferred: '{ completedValue: 3, totalValue: 10 }',
    })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Component file' })).toHaveValue('src/Cart.tsx'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Infer props' }))
    expect(stubbed.inferProps).toHaveBeenCalledWith('/app', 'src/Cart.tsx')

    const props = screen.getByRole('textbox', { name: 'Component props' })
    await waitFor(() => expect(props).toHaveValue('{ completedValue: 3, totalValue: 10 }'))

    // The inferred props are editable before pinning.
    fireEvent.change(props, { target: { value: '{ completedValue: 5, totalValue: 10 }' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    expect(stubbed.setComponent).toHaveBeenCalledWith(
      '/app',
      'src/Cart.tsx',
      null,
      '{ completedValue: 5, totalValue: 10 }',
    )
  })

  it('generates a context wrapper via the agent and fills the wrapper field', async () => {
    const stubbed = stub({
      component: { root: '/app', file: 'src/Page.tsx' },
      inferredWrapper: '__agentinator_wrapper.tsx',
    })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Component file' })).toHaveValue('src/Page.tsx'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Infer wrapper' }))
    expect(stubbed.inferWrapper).toHaveBeenCalledWith('/app', 'src/Page.tsx')

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Wrapper file' })).toHaveValue(
        '__agentinator_wrapper.tsx',
      ),
    )
  })

  it('does not infer without a component root and file', () => {
    const stubbed = stub()
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    fireEvent.click(screen.getByRole('button', { name: 'Infer props' }))

    expect(stubbed.inferProps).not.toHaveBeenCalled()
  })

  it('surfaces an inference failure', async () => {
    const stubbed = stub({ component: { root: '/app', file: 'src/Cart.tsx' } })
    stubbed.inferProps.mockRejectedValueOnce(new Error('model unavailable'))
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Component file' })).toHaveValue('src/Cart.tsx'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Infer props' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('model unavailable'))

    // A non-Error rejection is stringified too.
    stubbed.inferProps.mockRejectedValueOnce('boom')
    fireEvent.click(screen.getByRole('button', { name: 'Infer props' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'))
  })

  it('loads a pinned component that has no wrapper', async () => {
    const stubbed = stub({ component: { root: '/app', file: 'src/Cart.tsx' } })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Component file' })).toHaveValue('src/Cart.tsx'),
    )
    expect(screen.getByRole('textbox', { name: 'Wrapper file' })).toHaveValue('')
  })

  it('pins nothing when the component file is left blank', async () => {
    const stubbed = stub()
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Component app root' }), {
      target: { value: '/app' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))

    // A blank file unpins (null), it doesn't pin an empty component.
    await waitFor(() => expect(stubbed.setComponent).toHaveBeenCalledWith('/app', null, null, null))
  })

  it('surfaces a failed capture instead of failing silently', async () => {
    const stubbed = stub()
    stubbed.capture.mockRejectedValueOnce(new Error('ENOENT: /Users/brian/myapp missing'))
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('ENOENT: /Users/brian/myapp missing')

    // A non-Error rejection is stringified; a fresh capture clears the message.
    stubbed.capture.mockRejectedValueOnce('boom')
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('boom'))
  })

  it('loads the configured preview target into the input', async () => {
    const stubbed = stub({ target: 'http://localhost:3001/' })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Preview target URL' })).toHaveValue(
        'http://localhost:3001/',
      ),
    )
  })

  it('saves a new target, and clears it to the sample when blanked', async () => {
    const stubbed = stub()
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    const input = screen.getByRole('textbox', { name: 'Preview target URL' })

    fireEvent.change(input, { target: { value: 'http://localhost:3001/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set' }))
    expect(stubbed.setPreviewTarget).toHaveBeenCalledWith('http://localhost:3001/')

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set' }))
    await waitFor(() => expect(stubbed.setPreviewTarget).toHaveBeenCalledWith(null))
  })

  it('renders captured network activity with failures flagged', async () => {
    const stubbed = stub({
      captures: [
        captureEvent(
          's',
          1,
          'shot_s',
          [],
          [
            { method: 'GET', url: 'http://localhost:3001/', status: 200, ok: true },
            { method: 'GET', url: 'http://localhost:4001/api/cart', status: 500, ok: false },
            { method: 'GET', url: 'http://localhost:4001/down', status: 0, ok: false },
          ],
        ),
      ],
    })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    const net = await screen.findByRole('region', { name: 'App network' })
    expect(net).toHaveTextContent('http://localhost:4001/api/cart')
    expect(net).toHaveTextContent('500')
    // An errored request (status 0) reads as "failed".
    expect(net).toHaveTextContent('failed')
    expect(net.querySelectorAll('.is-failed')).toHaveLength(2)
  })

  it('seeds the latest capture for the session and renders its screenshot', async () => {
    const stubbed = stub({
      captures: [captureEvent('other', 1), captureEvent('s', 2, 'shot_s')],
    })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    await waitFor(() => {
      expect(screen.getByRole('img', { name: /screenshot of the target app/i })).toHaveAttribute(
        'src',
        'data:image/png;base64,YWJj',
      )
    })
    expect(stubbed.search).toHaveBeenCalledWith('preview.captured', 30)
    expect(stubbed.image).toHaveBeenCalledWith('shot_s')
    expect(screen.getByText('1280×800')).toBeInTheDocument()
  })

  it('shows the captured console output beneath the screenshot', async () => {
    const stubbed = stub({
      captures: [
        captureEvent('s', 2, 'shot_s', [
          { level: 'error', text: 'Uncaught TypeError: x is undefined' },
          { level: 'warning', text: 'deprecated API' },
        ]),
      ],
    })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    const console = await screen.findByRole('region', { name: 'App console' })
    expect(console).toHaveTextContent('Uncaught TypeError: x is undefined')
    expect(console).toHaveTextContent('deprecated API')
    expect(console.querySelector('.level-error')).not.toBeNull()
  })

  it('tolerates a legacy capture with no console field', async () => {
    const legacy: StoredEvent = {
      seq: 1,
      ts: 't',
      type: 'preview.captured',
      payload: { sessionId: 's', ref: 'shot_x', url: 'file:///sample', width: 10, height: 10 },
    }
    const stubbed = stub({ captures: [legacy] })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument())
    expect(screen.queryByRole('region', { name: 'App console' })).not.toBeInTheDocument()
  })

  it('points at a spot and sends it, with a note and the screenshot, to the agent', async () => {
    const stubbed = stub({ captures: [captureEvent('s', 1, 'shot_s')] })
    const frame = await renderAndMark(stubbed)

    const marker = frame.querySelector<HTMLElement>('.preview-mark')
    expect(marker).not.toBeNull()
    expect(marker?.style.left).toBe('50%')
    expect(marker?.style.top).toBe('50%')

    fireEvent.change(screen.getByRole('textbox', { name: 'Note about the marked spot' }), {
      target: { value: 'this button is misaligned' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))

    expect(stubbed.agentSend).toHaveBeenCalledWith(
      's',
      'Pointing at the app preview at 50% across, 50% down: this button is misaligned.',
      [{ mediaType: 'image/png', data: 'YWJj' }],
    )
    // The mark clears after sending.
    expect(frame.querySelector('.preview-mark')).toBeNull()
  })

  it('sends a bare mark with no note, omitting the description', async () => {
    const stubbed = stub({ captures: [captureEvent('s', 1)] })
    await renderAndMark(stubbed)

    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))

    expect(stubbed.agentSend).toHaveBeenCalledWith(
      's',
      'Pointing at the app preview at 50% across, 50% down.',
      [{ mediaType: 'image/png', data: 'YWJj' }],
    )
  })

  it('cancels a mark without sending', async () => {
    const stubbed = stub({ captures: [captureEvent('s', 1)] })
    const frame = await renderAndMark(stubbed)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(frame.querySelector('.preview-mark')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send to agent' })).not.toBeInTheDocument()
    expect(stubbed.agentSend).not.toHaveBeenCalled()
  })

  it('no-ops the send when the bridge has gone away', async () => {
    const stubbed = stub({ captures: [captureEvent('s', 1)] })
    await renderAndMark(stubbed)

    delete window.agentinator
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))

    expect(stubbed.agentSend).not.toHaveBeenCalled()
  })

  it('stays empty when no capture belongs to the session', async () => {
    const stubbed = stub({ captures: [captureEvent('other', 1)] })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    await waitFor(() => expect(stubbed.search).toHaveBeenCalled())
    expect(screen.getByText(/Capture a screenshot of the target app/)).toBeInTheDocument()
    expect(stubbed.image).not.toHaveBeenCalled()
  })

  it('leaves the pane empty when the screenshot bytes are gone', async () => {
    const stubbed = stub({ captures: [captureEvent('s', 1)], image: null })
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)

    await waitFor(() => expect(stubbed.image).toHaveBeenCalled())
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText(/Capture a screenshot of the target app/)).toBeInTheDocument()
  })

  it('updates live for its own session and ignores others and non-captures', async () => {
    const stubbed = stub()
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    await waitFor(() => expect(stubbed.search).toHaveBeenCalled())

    act(() => {
      stubbed.emit(captureEvent('s', 5, 'shot_live'))
      stubbed.emit(captureEvent('other', 6))
      stubbed.emit({ seq: 7, ts: 't', type: 'agent.text', payload: { sessionId: 's', text: 'x' } })
    })

    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument())
    expect(stubbed.image).toHaveBeenCalledTimes(1)
    expect(stubbed.image).toHaveBeenCalledWith('shot_live')
  })

  it('captures on click, showing progress while the request is in flight', async () => {
    const stubbed = stub()
    let resolveCapture: (ref: string) => void = () => undefined
    stubbed.capture.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveCapture = resolve
      }),
    )
    window.agentinator = stubbed.bridge

    render(<Preview sessionId="s" />)
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(stubbed.capture).toHaveBeenCalledWith('s')
    expect(screen.getByRole('button', { name: 'Capturing…' })).toBeDisabled()

    resolveCapture('shot_new')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Capture' })).toBeEnabled())
  })

  it('ignores a late load after unmount and unsubscribes', async () => {
    let resolveSearch: (events: StoredEvent[]) => void = () => undefined
    const stubbed = stub()
    stubbed.search.mockReturnValue(
      new Promise<StoredEvent[]>((resolve) => {
        resolveSearch = resolve
      }),
    )
    window.agentinator = stubbed.bridge

    const { unmount } = render(<Preview sessionId="s" />)
    unmount()
    resolveSearch([captureEvent('s', 1)])
    await Promise.resolve()

    expect(stubbed.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
