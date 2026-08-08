// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { Timeline } from './Timeline'

function stored<T extends EventType>(type: T, payload: EventPayloads[T], seq: number): StoredEvent {
  return { seq, ts: 't', type, payload } as StoredEvent
}

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function stubBridge(list: Promise<StoredEvent[]>): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  return {
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        list: vi.fn(() => list),
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

  it('renders the fetched log as readable lines', async () => {
    const stub = stubBridge(
      Promise.resolve([
        stored('app.started', { version: '0.1.0' }, 1),
        stored('agent.text', { sessionId: 's', text: 'Hello from the agent.' }, 2),
      ]),
    )
    window.agentinator = stub.bridge

    render(<Timeline />)

    await waitFor(() => {
      expect(screen.getByText('Hello from the agent.')).toBeInTheDocument()
    })
    expect(screen.getByText('app started v0.1.0')).toBeInTheDocument()
    expect(screen.queryByText(/Agent activity will stream here/)).not.toBeInTheDocument()
  })

  it('appends live events and dedupes ones already in the fetched list', async () => {
    const listed = stored('agent.text', { sessionId: 's', text: 'first' }, 1)
    const stub = stubBridge(Promise.resolve([listed]))
    window.agentinator = stub.bridge

    render(<Timeline />)
    await waitFor(() => {
      expect(screen.getByText('first')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(listed)
      stub.emit(stored('agent.text', { sessionId: 's', text: 'second' }, 2))
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
      const stub = stubBridge(
        Promise.resolve([stored('agent.text', { sessionId: 's', text: 'line' }, 1)]),
      )
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

  it('unsubscribes on unmount and ignores a late list', async () => {
    let resolveList: (events: StoredEvent[]) => void = () => undefined
    const stub = stubBridge(
      new Promise<StoredEvent[]>((resolve) => {
        resolveList = resolve
      }),
    )
    window.agentinator = stub.bridge

    const { unmount } = render(<Timeline />)
    unmount()
    resolveList([stored('agent.text', { sessionId: 's', text: 'late' }, 1)])
    await Promise.resolve()

    expect(stub.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByText('late')).not.toBeInTheDocument()
  })
})
