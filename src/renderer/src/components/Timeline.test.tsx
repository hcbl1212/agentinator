// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { Timeline } from './Timeline'

function stored<T extends EventType>(type: T, payload: EventPayloads[T], seq: number): StoredEvent {
  return { seq, ts: 't', type, payload } as StoredEvent
}

function text(seq: number, body: string): StoredEvent {
  return stored('agent.text', { sessionId: 's', text: body }, seq)
}

interface BridgeStub {
  bridge: AgentinatorBridge
  tail: ReturnType<typeof vi.fn>
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function stubBridge(pages: (limit: number, beforeSeq?: number) => StoredEvent[]): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const tail = vi.fn((limit: number, beforeSeq?: number) =>
    Promise.resolve(pages(limit, beforeSeq)),
  )
  return {
    tail,
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        list: vi.fn(() => Promise.resolve([])),
        tail: tail as AgentinatorBridge['events']['tail'],
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return unsubscribe as () => void
        }),
      },
      agent: {
        startDemo: vi.fn(() => Promise.resolve('session_1')),
        cancel: vi.fn(() => Promise.resolve()),
      },
    },
    emit: (event) => appended?.(event),
    unsubscribe,
  }
}

afterEach(() => {
  delete window.agentinator
})

describe('Timeline', () => {
  it('shows the empty state without a bridge', () => {
    render(<Timeline />)

    expect(screen.getByText(/Agent activity will stream here/)).toBeInTheDocument()
  })

  it('fetches only the newest window, not the whole log', async () => {
    const stub = stubBridge(() => [text(1, 'first line')])
    window.agentinator = stub.bridge

    render(<Timeline pageSize={50} />)

    await waitFor(() => {
      expect(screen.getByText('first line')).toBeInTheDocument()
    })
    expect(stub.tail).toHaveBeenCalledWith(50)
    expect(stub.bridge.events.list).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Load earlier/ })).not.toBeInTheDocument()
  })

  it('pages backward with Load earlier until the start of the log', async () => {
    const stub = stubBridge((_limit, beforeSeq) =>
      beforeSeq === undefined ? [text(3, 'newest')] : [text(1, 'oldest'), text(2, 'middle')],
    )
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Timeline pageSize={2} />)
    await waitFor(() => {
      expect(screen.getByText('newest')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /Load earlier/ }))

    expect(stub.tail).toHaveBeenLastCalledWith(2, 3)
    await waitFor(() => {
      expect(screen.getByText('oldest')).toBeInTheDocument()
    })
    expect(screen.getByText('middle')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Load earlier/ })).not.toBeInTheDocument()
  })

  it('does nothing when Load earlier is clicked after the bridge vanished', async () => {
    const stub = stubBridge(() => [text(5, 'windowed')])
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Timeline pageSize={2} />)
    await waitFor(() => {
      expect(screen.getByText('windowed')).toBeInTheDocument()
    })

    delete window.agentinator
    await user.click(screen.getByRole('button', { name: /Load earlier/ }))

    expect(stub.tail).toHaveBeenCalledTimes(1)
  })

  it('appends live events and dedupes ones already in the window', async () => {
    const listed = text(1, 'first')
    const stub = stubBridge(() => [listed])
    window.agentinator = stub.bridge

    render(<Timeline />)
    await waitFor(() => {
      expect(screen.getByText('first')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(listed)
      stub.emit(text(2, 'second'))
    })

    expect(screen.getAllByText('first')).toHaveLength(1)
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('scrolls the newest line into view when the DOM supports it', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })
    try {
      const stub = stubBridge(() => [text(1, 'line')])
      window.agentinator = stub.bridge

      render(<Timeline />)
      await waitFor(() => {
        expect(screen.getByText('line')).toBeInTheDocument()
      })

      expect(scrollIntoView).toHaveBeenCalled()
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('unsubscribes on unmount and ignores a late window', async () => {
    let resolveTail: (events: StoredEvent[]) => void = () => undefined
    const late = new Promise<StoredEvent[]>((resolve) => {
      resolveTail = resolve
    })
    const stub = stubBridge(() => [])
    stub.tail.mockReturnValue(late)
    window.agentinator = stub.bridge

    const { unmount } = render(<Timeline />)
    unmount()
    resolveTail([text(1, 'late')])
    await Promise.resolve()

    expect(stub.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByText('late')).not.toBeInTheDocument()
  })
})
