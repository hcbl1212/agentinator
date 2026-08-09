// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { ConsoleEntry, StoredEvent } from '../../../shared/events'
import { Preview } from './Preview'

function captureEvent(
  sessionId: string,
  seq: number,
  ref = `shot_${seq}`,
  console: ConsoleEntry[] = [],
): StoredEvent {
  return {
    seq,
    ts: 't',
    type: 'preview.captured',
    payload: { sessionId, ref, url: 'file:///sample', width: 1280, height: 800, console },
  }
}

interface Stub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  image: ReturnType<typeof vi.fn>
  capture: ReturnType<typeof vi.fn>
}

function stub(options: { captures?: StoredEvent[]; image?: string | null } = {}): Stub {
  const { captures = [], image = 'YWJj' } = options
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const search = vi.fn(() => Promise.resolve(captures))
  const imageFn = vi.fn(() => Promise.resolve(image))
  const capture = vi.fn(() => Promise.resolve('shot_new'))
  const bridge = {
    events: {
      search,
      onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
        appended = listener
        return unsubscribe as () => void
      }),
    },
    preview: { capture, image: imageFn },
  } as unknown as AgentinatorBridge
  return {
    bridge,
    emit: (event) => appended?.(event),
    unsubscribe,
    search,
    image: imageFn,
    capture,
  }
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

  it('shows the capture prompt and no-ops the button without a bridge', () => {
    render(<Preview sessionId="s" />)

    expect(screen.getByText(/Capture a screenshot of the target app/)).toBeInTheDocument()
    // Clicking without a bridge must not throw.
    fireEvent.click(screen.getByRole('button', { name: 'Capture' }))
    expect(screen.getByRole('button', { name: 'Capture' })).toBeEnabled()
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
