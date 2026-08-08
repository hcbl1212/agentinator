// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { StatusBar } from './StatusBar'

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function stubBridge(count: Promise<number>): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  return {
    bridge: {
      events: {
        count: vi.fn(() => count),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return unsubscribe as () => void
        }),
      },
      agent: {
        startDemo: vi.fn(() => Promise.resolve('session_1')),
        cancel: vi.fn(() => Promise.resolve()),
      },
      approvals: {
        pending: vi.fn(() => Promise.resolve([])),
        resolve: vi.fn(() => Promise.resolve()),
      },
    },
    emit: (event) => appended?.(event),
    unsubscribe,
  }
}

function storedEvent(seq: number): StoredEvent {
  return { seq, ts: 't', type: 'agent.text', payload: { sessionId: 's', text: 'x' } }
}

afterEach(() => {
  delete window.agentinator
})

describe('StatusBar', () => {
  it('shows a placeholder when no bridge is available (plain browser/test)', () => {
    render(<StatusBar />)

    expect(screen.getByText('log —')).toBeInTheDocument()
  })

  it('shows the event-log count fetched over the bridge', async () => {
    window.agentinator = stubBridge(Promise.resolve(3)).bridge

    render(<StatusBar />)

    await waitFor(() => {
      expect(screen.getByText('log 3 events')).toBeInTheDocument()
    })
  })

  it('updates the count live as events are appended', async () => {
    const stub = stubBridge(Promise.resolve(3))
    window.agentinator = stub.bridge

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('log 3 events')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(storedEvent(4))
    })

    expect(screen.getByText('log 4 events')).toBeInTheDocument()
  })

  it('reports cache health from accumulated cost events', async () => {
    const stub = stubBridge(Promise.resolve(1))
    window.agentinator = stub.bridge

    render(<StatusBar />)
    expect(screen.getByText('cache —')).toBeInTheDocument()

    act(() => {
      stub.emit({
        seq: 2,
        ts: 't',
        type: 'cost.usage',
        payload: {
          sessionId: 's',
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 300,
          usd: 0.01,
        },
      } as StoredEvent)
    })

    expect(screen.getByText('cache 75%')).toBeInTheDocument()
  })

  it('unsubscribes from appends on unmount and ignores a late count', async () => {
    let resolveCount: (n: number) => void = () => undefined
    const stub = stubBridge(
      new Promise<number>((resolve) => {
        resolveCount = resolve
      }),
    )
    window.agentinator = stub.bridge

    const { unmount } = render(<StatusBar />)
    unmount()
    resolveCount(9)
    await Promise.resolve()

    expect(stub.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByText('log 9 events')).not.toBeInTheDocument()
  })
})
