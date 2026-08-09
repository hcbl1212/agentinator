// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { Timeline } from './Timeline'

function stored<T extends EventType>(type: T, payload: EventPayloads[T], seq: number): StoredEvent {
  return { seq, ts: 't', type, payload }
}

function text(seq: number, body: string): StoredEvent {
  return stored('agent.text', { sessionId: 's', text: body }, seq)
}

interface BridgeStub {
  bridge: AgentinatorBridge
  tail: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function stubBridge(
  pages: (limit: number, beforeSeq?: number) => StoredEvent[],
  found: (query: string) => StoredEvent[] = () => [],
): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const tail = vi.fn((limit: number, beforeSeq?: number) =>
    Promise.resolve(pages(limit, beforeSeq)),
  )
  const search = vi.fn((query: string) => Promise.resolve(found(query)))
  return {
    tail,
    search,
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: tail,
        search: search,
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return unsubscribe as () => void
        }),
      },
      settings: {
        getBudgets: vi.fn(() =>
          Promise.resolve({ session: 5, hour: null, day: null, week: null, month: null }),
        ),
        setBudget: vi.fn(() => Promise.resolve()),
      },
      agent: {
        current: vi.fn(() => Promise.resolve({ providerId: 'claude', label: 'Claude' })),
        startDemo: vi.fn(() => Promise.resolve('session_1')),
        startTask: vi.fn(() => Promise.resolve('s')),
        send: vi.fn(() => Promise.resolve()),
        cancel: vi.fn(() => Promise.resolve()),
      },
      approvals: {
        pending: vi.fn(() => Promise.resolve([])),
        resolve: vi.fn(() => Promise.resolve()),
        undo: vi.fn(() => Promise.resolve()),
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

  it('scopes to a session id, hiding other agents’ events', async () => {
    const stub = stubBridge(() => [
      stored('agent.text', { sessionId: 'a', text: 'from A' }, 1),
      stored('agent.text', { sessionId: 'b', text: 'from B' }, 2),
    ])
    window.agentinator = stub.bridge

    render(<Timeline sessionId="a" />)

    await waitFor(() => {
      expect(screen.getByText('from A')).toBeInTheDocument()
    })
    expect(screen.queryByText('from B')).not.toBeInTheDocument()
  })

  it('search is inert without a bridge', async () => {
    const user = userEvent.setup()

    render(<Timeline />)
    await user.type(screen.getByRole('searchbox', { name: 'Search events' }), 'x')

    expect(screen.getByText(/No matches for “x”/)).toBeInTheDocument()
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

  it('searches the whole log and shows matches, hiding paging and clear', async () => {
    const stub = stubBridge(
      () => [text(9, 'window line')],
      (query) => (query === 'greet' ? [text(2, 'greet match')] : []),
    )
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Timeline pageSize={5} />)
    await waitFor(() => {
      expect(screen.getByText('window line')).toBeInTheDocument()
    })

    await user.type(screen.getByRole('searchbox', { name: 'Search events' }), 'greet')

    await waitFor(() => {
      expect(screen.getByText('greet match')).toBeInTheDocument()
    })
    expect(stub.search).toHaveBeenLastCalledWith('greet', 5)
    expect(screen.queryByText('window line')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Load earlier/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })

  it('shows a no-matches empty state and folds matching live appends into results', async () => {
    const stub = stubBridge(
      () => [],
      () => [],
    )
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Timeline />)
    await user.type(screen.getByRole('searchbox', { name: 'Search events' }), 'greet')
    await waitFor(() => {
      expect(screen.getByText(/No matches for “greet”/)).toBeInTheDocument()
    })

    act(() => {
      stub.emit(text(4, 'a live greet event'))
      stub.emit(text(5, 'unrelated'))
    })

    expect(screen.getByText('a live greet event')).toBeInTheDocument()
    expect(screen.queryByText('unrelated')).not.toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'Search events' }))
    await waitFor(() => {
      expect(screen.getByText('unrelated')).toBeInTheDocument()
    })
  })

  it('clears the view only — history restores via Load earlier', async () => {
    const stub = stubBridge((_limit, beforeSeq) =>
      beforeSeq === undefined ? [text(4, 'visible line')] : [text(3, 'restored line')],
    )
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Timeline pageSize={2} />)
    await waitFor(() => {
      expect(screen.getByText('visible line')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    expect(screen.getByText(/View cleared/)).toBeInTheDocument()
    expect(screen.queryByText('visible line')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Load earlier/ }))
    await waitFor(() => {
      expect(screen.getByText('restored line')).toBeInTheDocument()
    })
    expect(stub.tail).toHaveBeenLastCalledWith(2, 5)

    act(() => {
      stub.emit(text(6, 'fresh after clear'))
    })
    expect(screen.getByText('fresh after clear')).toBeInTheDocument()
  })

  it('clearing an empty view keeps the default empty state', async () => {
    const stub = stubBridge(() => [text(1, 'only line')])
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Timeline />)
    await waitFor(() => {
      expect(screen.getByText('only line')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    expect(screen.getByText(/View cleared/)).toBeInTheDocument()
  })

  it('pauses autoscroll while reading history and re-pins via Latest', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })
    try {
      const stub = stubBridge(() => [text(1, 'a line')])
      window.agentinator = stub.bridge

      render(<Timeline />)
      await waitFor(() => {
        expect(screen.getByText('a line')).toBeInTheDocument()
      })

      const pane = screen.getByRole('region', { name: 'Activity timeline' })
      Object.defineProperty(pane, 'scrollHeight', { value: 1000, configurable: true })
      Object.defineProperty(pane, 'clientHeight', { value: 200, configurable: true })
      pane.scrollTop = 100
      fireEvent.scroll(pane)

      expect(pane.className).toContain('is-scrolled')
      const callsWhileUnpinned = scrollIntoView.mock.calls.length

      act(() => {
        stub.emit(text(2, 'new while reading'))
      })
      expect(scrollIntoView.mock.calls.length).toBe(callsWhileUnpinned)
      expect(screen.getByText('new while reading')).toBeInTheDocument()

      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: '↓ Latest' }))

      expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsWhileUnpinned)
      expect(screen.queryByRole('button', { name: '↓ Latest' })).not.toBeInTheDocument()

      pane.scrollTop = 960
      fireEvent.scroll(pane)
      expect(pane.className).toContain('is-scrolled')
      expect(screen.queryByRole('button', { name: '↓ Latest' })).not.toBeInTheDocument()

      pane.scrollTop = 0
      fireEvent.scroll(pane)
      expect(pane.className).not.toContain('is-scrolled')
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('ignores search results that resolve after unmount', async () => {
    let resolveSearch: (results: StoredEvent[]) => void = () => undefined
    const stub = stubBridge(() => [])
    stub.search.mockReturnValue(
      new Promise<StoredEvent[]>((resolve) => {
        resolveSearch = resolve
      }),
    )
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    const { unmount } = render(<Timeline />)
    await user.type(screen.getByRole('searchbox', { name: 'Search events' }), 'g')
    unmount()
    resolveSearch([text(1, 'stale result')])
    await Promise.resolve()

    expect(screen.queryByText('stale result')).not.toBeInTheDocument()
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
