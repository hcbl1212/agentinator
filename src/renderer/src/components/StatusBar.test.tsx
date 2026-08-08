// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { Budgets } from '../../../shared/budget'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { StatusBar } from './StatusBar'

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
  setBudget: ReturnType<typeof vi.fn>
}

function budgets(overrides: Partial<Budgets> = {}): Budgets {
  return { session: 5, hour: null, day: null, week: null, month: null, ...overrides }
}

function stubBridge(
  options: { count?: number; total?: number; budgets?: Budgets } = {},
): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const setBudget = vi.fn(() => Promise.resolve())
  return {
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(options.count ?? 0)),
        totalCost: vi.fn(() => Promise.resolve(options.total ?? 0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return unsubscribe as () => void
        }),
      },
      settings: {
        getBudgets: vi.fn(() => Promise.resolve(options.budgets ?? budgets())),
        setBudget: setBudget as AgentinatorBridge['settings']['setBudget'],
      },
      agent: {
        startDemo: vi.fn(() => Promise.resolve('session_1')),
        startTask: vi.fn(() => Promise.resolve('s')),
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
    setBudget,
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

  it('backfills total spend and the session cap on mount', async () => {
    window.agentinator = stubBridge({
      count: 3,
      total: 1.2345,
      budgets: budgets({ session: 8 }),
    }).bridge

    render(<StatusBar />)

    await waitFor(() => {
      expect(screen.getByText('$1.2345')).toBeInTheDocument()
    })
    expect(screen.getByText('log 3 events')).toBeInTheDocument()
    expect(screen.getByText('session $0.00 / $8.00')).toBeInTheDocument()
  })

  it('shows session spend without a cap when the session budget is cleared', async () => {
    window.agentinator = stubBridge({ budgets: budgets({ session: null }) }).bridge

    render(<StatusBar />)

    await waitFor(() => {
      expect(screen.getByText('session $0.00')).toBeInTheDocument()
    })
  })

  it('accumulates spend live into both the total and the current session', async () => {
    const stub = stubBridge({ total: 1 })
    window.agentinator = stub.bridge

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('$1.0000')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(event(2, 'agent.text', { sessionId: 's', text: 'hi' }))
      stub.emit(cost(3, 0.5))
    })

    expect(screen.getByText('$1.5000')).toBeInTheDocument()
    expect(screen.getByText('session $0.50 / $5.00')).toBeInTheDocument()
    expect(screen.getByText('cache 75%')).toBeInTheDocument()
    expect(screen.getByText('log 3 events')).toBeInTheDocument()
  })

  it('resets the session figure when a new session starts', async () => {
    const stub = stubBridge()
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
    const stub = stubBridge({ budgets: budgets({ session: 1 }) })
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

  it('opens the budget panel and edits a time-window cap', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<StatusBar />)
    await waitFor(() => {
      expect(screen.getByText('session $0.00 / $5.00')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /session/ }))
    expect(screen.getByRole('dialog', { name: 'Budget settings' })).toBeInTheDocument()

    const dayInput = screen.getByRole('spinbutton', { name: 'Day budget in dollars' })
    await user.type(dayInput, '20')
    await user.keyboard('{Enter}')

    expect(stub.setBudget).toHaveBeenCalledWith('day', 20)

    await user.click(screen.getByRole('button', { name: 'Close budgets' }))
    expect(screen.queryByRole('dialog', { name: 'Budget settings' })).not.toBeInTheDocument()
  })

  it('unsubscribes on unmount and ignores a late load', async () => {
    let resolve: (values: [number, number, Budgets]) => void = () => undefined
    const stub = stubBridge()
    const pending = new Promise<[number, number, Budgets]>((r) => {
      resolve = r
    })
    ;(stub.bridge.events.count as ReturnType<typeof vi.fn>).mockReturnValue(
      pending.then(([count]) => count),
    )
    ;(stub.bridge.events.totalCost as ReturnType<typeof vi.fn>).mockReturnValue(
      pending.then(([, total]) => total),
    )
    ;(stub.bridge.settings.getBudgets as ReturnType<typeof vi.fn>).mockReturnValue(
      pending.then(([, , loaded]) => loaded),
    )
    window.agentinator = stub.bridge

    const { unmount } = render(<StatusBar />)
    unmount()
    resolve([9, 9, budgets()])
    await Promise.resolve()

    expect(stub.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByText('log 9 events')).not.toBeInTheDocument()
  })
})
