// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { DiffView } from './DiffView'

function diffEvent(path: string, patch: string, seq: number, additions = 1): StoredEvent {
  return {
    seq,
    ts: 't',
    type: 'file.diffed',
    payload: { sessionId: 's', path, additions, deletions: 0, patch },
  } as StoredEvent
}

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

function stubBridge(diffs: StoredEvent[]): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  return {
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve(diffs)),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
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
        startDemo: vi.fn(() => Promise.resolve('s')),
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

describe('DiffView', () => {
  it('shows the empty state without a bridge', () => {
    render(<DiffView />)

    expect(screen.getByText(/File changes appear here/)).toBeInTheDocument()
  })

  it('renders per-file diffs with colored lines and stats', async () => {
    window.agentinator = stubBridge([diffEvent('src/a.ts', '@@ -1 +1 @@\n-old\n+new', 1, 1)]).bridge

    render(<DiffView />)

    await waitFor(() => {
      expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    })
    expect(screen.getByText('+new')).toHaveClass('diff-add')
    expect(screen.getByText('-old')).toHaveClass('diff-del')
    expect(screen.getByText('@@ -1 +1 @@')).toHaveClass('diff-hunk')
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('updates live as file.diffed events land, replacing a path in place', async () => {
    const stub = stubBridge([diffEvent('a.ts', '+one', 1)])
    window.agentinator = stub.bridge

    render(<DiffView />)
    await waitFor(() => {
      expect(screen.getByText('+one')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(diffEvent('a.ts', '+two', 2))
      stub.emit(diffEvent('b.ts', '+bee', 3))
    })

    expect(screen.queryByText('+one')).not.toBeInTheDocument()
    expect(screen.getByText('+two')).toBeInTheDocument()
    expect(screen.getByText('+bee')).toBeInTheDocument()
  })

  it('ignores non-diff events and a late load after unmount', async () => {
    let resolve: (events: StoredEvent[]) => void = () => undefined
    const stub = stubBridge([])
    ;(stub.bridge.events.diffs as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<StoredEvent[]>((r) => {
        resolve = r
      }),
    )
    window.agentinator = stub.bridge

    const { unmount } = render(<DiffView />)
    unmount()
    resolve([diffEvent('late.ts', '+late', 1)])
    await Promise.resolve()

    expect(stub.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByText('+late')).not.toBeInTheDocument()
  })

  it('does not add a card for a non-diff live event', async () => {
    const stub = stubBridge([])
    window.agentinator = stub.bridge

    render(<DiffView />)
    await waitFor(() => {
      expect(screen.getByText(/File changes appear here/)).toBeInTheDocument()
    })

    act(() => {
      stub.emit({
        seq: 5,
        ts: 't',
        type: 'agent.text',
        payload: { sessionId: 's', text: 'x' },
      } as StoredEvent)
    })

    expect(screen.getByText(/File changes appear here/)).toBeInTheDocument()
  })
})
