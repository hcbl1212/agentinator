// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { StatusBar } from './StatusBar'

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
  setBudgetUsd: ReturnType<typeof vi.fn>
}

function stubBridge(options: { count?: number; total?: number; budget?: number } = {}): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const setBudgetUsd = vi.fn(() => Promise.resolve())
  return {
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(options.count ?? 0)),
        totalCost: vi.fn(() => Promise.resolve(options.total ?? 0)),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return unsubscribe as () => void
        }),
      },
      settings: {
        getBudgetUsd: vi.fn(() => Promise.resolve(options.budget ?? 5)),
        setBudgetUsd: setBudgetUsd as AgentinatorBridge['settings']['setBudgetUsd'],
      },
      agent: {
        startDemo: vi.fn(() => Promise.resolve('session_1')),
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
    setBudgetUsd,
  }
}

function event<T extends EventType>(seq: number, type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq, ts: 't', type, payload } as StoredEvent
}

function cost(seq: number, usd: number): StoredEvent {
  return event(seq, 'cost.usage', {
    sessionId: 's',
    inputTokens: 100,
    outputTokens: 10,
    cacheReadInputTokens: 300,
    usd,
  })
}

afterEach(() => {
  delete window.agentinator
})

describe('StatusBar', () => {
  it('shows placeholders when no bridge is available (plain browser/test)', () => {
    render(<StatusBar />)

    expect(screen.getByText('log —')).toBeInTheDocument()
    expect(screen.getByText('$0.0000')).toBeInTheDocument()
    expect(screen.getByText('cache —')).toBeInTheDocument()
    expect(screen.getByText('budget —')).toBeInTheDocument()
  })

  it('backfills total spend and the budget on mount', async () => {
    window.agentinator = stubBridge({ count: 3, total: 1.2345, budget: 8 }).bridge

    render(<StatusBar />)

    await waitFor(() => {
      expect(screen.getByText('$1.2345')).toBeInTheDocument()
    })
    expect(screen.getByText('log 3 events')).toBeInTheDocument()
    expect(screen.getByText('session $0.00 / $8.00')).toBeInTheDocument()
  })

  it('accumulates spend live into both the total and the current session', async () => {
    const stub = stubBridge({ total: 1, budget: 5 })
    window.agentinator = stub.bridge

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('$1.0000')).toBeInTheDocument()
    })

    act(() => {
      // An unrelated event bumps the log count but not spend.
      stub.emit(event(2, 'agent.text', { sessionId: 's', text: 'hi' }))
      stub.emit(cost(3, 0.5))
    })

    expect(screen.getByText('$1.5000')).toBeInTheDocument()
    expect(screen.getByText('session $0.50 / $5.00')).toBeInTheDocument()
    expect(screen.getByText('cache 75%')).toBeInTheDocument()
    expect(screen.getByText('log 3 events')).toBeInTheDocument()
  })

  it('can open the budget editor from the placeholder when spend is unknown', async () => {
    render(<StatusBar />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'budget —' }))

    const input = screen.getByRole('spinbutton', { name: 'Session budget in dollars' })
    expect(input).toHaveValue(null)
  })

  it('resets the session figure when a new session starts', async () => {
    const stub = stubBridge({ budget: 5 })
    window.agentinator = stub.bridge

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('session $0.00 / $5.00')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(cost(2, 2))
    })
    expect(screen.getByText('session $2.00 / $5.00')).toBeInTheDocument()

    act(() => {
      stub.emit(
        event(3, 'session.started', {
          sessionId: 's2',
          agentId: 'a',
          workspaceId: 'w',
          title: 'T',
        }),
      )
    })
    expect(screen.getByText('session $0.00 / $5.00')).toBeInTheDocument()
  })

  it('warms to amber near the cap and red at breach', async () => {
    const stub = stubBridge({ budget: 1 })
    window.agentinator = stub.bridge

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('session $0.00 / $1.00')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(cost(2, 0.85))
    })
    expect(screen.getByRole('button', { name: /session/ }).className).toContain('budget-near')

    act(() => {
      stub.emit(cost(3, 0.2))
    })
    expect(screen.getByRole('button', { name: /session/ }).className).toContain('budget-over')
  })

  it('edits the budget and persists it', async () => {
    const stub = stubBridge({ budget: 5 })
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('session $0.00 / $5.00')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /session/ }))
    const input = screen.getByRole('spinbutton', { name: 'Session budget in dollars' })
    await user.clear(input)
    await user.type(input, '12')
    await user.keyboard('{Enter}')

    expect(stub.setBudgetUsd).toHaveBeenCalledWith(12)
    expect(screen.getByText('session $0.00 / $12.00')).toBeInTheDocument()
  })

  it('cancels an edit on Escape without persisting', async () => {
    const stub = stubBridge({ budget: 5 })
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('session $0.00 / $5.00')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /session/ }))
    await user.type(screen.getByRole('spinbutton'), '99')
    await user.keyboard('{Escape}')

    expect(stub.setBudgetUsd).not.toHaveBeenCalled()
    expect(screen.getByText('session $0.00 / $5.00')).toBeInTheDocument()
  })

  it('ignores a non-positive budget edit', async () => {
    const stub = stubBridge({ budget: 5 })
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('session $0.00 / $5.00')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /session/ }))
    const input = screen.getByRole('spinbutton')
    await user.clear(input)
    await user.type(input, '0')
    fireEvent.blur(input)

    expect(stub.setBudgetUsd).not.toHaveBeenCalled()
    expect(screen.getByText('session $0.00 / $5.00')).toBeInTheDocument()
  })

  it('unsubscribes on unmount and ignores a late load', async () => {
    let resolve: (values: [number, number, number]) => void = () => undefined
    const stub = stubBridge()
    const pending = new Promise<[number, number, number]>((r) => {
      resolve = r
    })
    ;(stub.bridge.events.count as ReturnType<typeof vi.fn>).mockReturnValue(
      pending.then(([count]) => count),
    )
    ;(stub.bridge.events.totalCost as ReturnType<typeof vi.fn>).mockReturnValue(
      pending.then(([, total]) => total),
    )
    ;(stub.bridge.settings.getBudgetUsd as ReturnType<typeof vi.fn>).mockReturnValue(
      pending.then(([, , budget]) => budget),
    )
    window.agentinator = stub.bridge

    const { unmount } = render(<StatusBar />)
    unmount()
    resolve([9, 9, 9])
    await Promise.resolve()

    expect(stub.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByText('log 9 events')).not.toBeInTheDocument()
  })
})
