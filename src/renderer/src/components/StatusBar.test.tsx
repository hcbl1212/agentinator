// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { Budgets } from '../../../shared/budget'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { StatusBar } from './StatusBar'
import { InboxProvider } from '../state/inbox'
import { SelectionProvider } from '../state/selection'
import { SessionsProvider } from '../state/sessions'

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
  const listeners: ((event: StoredEvent) => void)[] = []
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
          listeners.push(listener)
          return unsubscribe as () => void
        }),
      },
      settings: {
        getBudgets: vi.fn(() => Promise.resolve(options.budgets ?? budgets())),
        setBudget: setBudget,
        getApiKeyMode: vi.fn(() => Promise.resolve(false)),
        setApiKeyMode: vi.fn(() => Promise.resolve()),
        getPreviewTarget: vi.fn(() => Promise.resolve(null)),
        setPreviewTarget: vi.fn(() => Promise.resolve()),
        getPreviewSettleMs: vi.fn(() => Promise.resolve(600)),
        setPreviewSettleMs: vi.fn(() => Promise.resolve()),
        getWorktreePreview: vi.fn(() => Promise.resolve(false)),
        setWorktreePreview: vi.fn(() => Promise.resolve()),
        getPreviewServerCommand: vi.fn(() => Promise.resolve('npm run dev')),
        setPreviewServerCommand: vi.fn(() => Promise.resolve()),
      },
      agent: {
        current: vi.fn(() => Promise.resolve({ providerId: 'claude', label: 'Claude' })),
        startDemo: vi.fn(() => Promise.resolve('session_1')),
        startTask: vi.fn(() => Promise.resolve('s')),
        send: vi.fn(() => Promise.resolve()),
        cancel: vi.fn(() => Promise.resolve()),
        dismiss: vi.fn(() => Promise.resolve()),
        switchToApiKey: vi.fn(() => Promise.resolve()),
        switchToSubscription: vi.fn(() => Promise.resolve()),
      },
      preview: {
        capture: vi.fn(() => Promise.resolve('shot_1')),
        image: vi.fn(() => Promise.resolve(null)),
        getComponent: vi.fn(() => Promise.resolve(null)),
        setComponent: vi.fn(() => Promise.resolve()),
        inferProps: vi.fn(() => Promise.resolve('{}')),
        inferWrapper: vi.fn(() => Promise.resolve('__agentinator_wrapper.tsx')),
        chooseFolder: vi.fn(() => Promise.resolve(null)),
        chooseFile: vi.fn(() => Promise.resolve(null)),
        startWorktreeServer: vi.fn(() => Promise.resolve(null)),
        stopWorktreeServers: vi.fn(() => Promise.resolve()),
        worktreeServerCount: vi.fn(() => Promise.resolve(0)),
        worktreeDepsChanged: vi.fn(() => Promise.resolve(false)),
      },
      approvals: {
        pending: vi.fn(() => Promise.resolve([])),
        resolve: vi.fn(() => Promise.resolve()),
        undo: vi.fn(() => Promise.resolve()),
      },
      worktrees: {
        summary: vi.fn(() => Promise.resolve({ count: 0, bytes: 0 })),
        cleanup: vi.fn(() => Promise.resolve({ count: 0, bytes: 0 })),
      },
      agentTypes: {
        list: vi.fn(() => Promise.resolve([])),
        save: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      },
      skills: {
        list: vi.fn(() => Promise.resolve([])),
        save: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      },
      queue: {
        add: vi.fn(() => Promise.resolve('task_x')),
        remove: vi.fn(() => Promise.resolve()),
        dispatch: vi.fn(() => Promise.resolve('session_new')),
      },
      pipelines: {
        create: vi.fn(() => Promise.resolve('pipeline_1')),
        continue: vi.fn(() => Promise.resolve()),
        revise: vi.fn(() => Promise.resolve()),
        approve: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      },
      planner: {
        create: vi.fn(() => Promise.resolve('plan_1')),
        dispatch: vi.fn(() => Promise.resolve(null)),
        remove: vi.fn(() => Promise.resolve()),
        addEdge: vi.fn(() => Promise.resolve(true)),
        removeEdge: vi.fn(() => Promise.resolve(true)),
        retype: vi.fn(() => Promise.resolve(true)),
        reprompt: vi.fn(() => Promise.resolve(true)),
      },
      checkpoints: {
        create: vi.fn(() => Promise.resolve('checkpoint_1')),
        restore: vi.fn(() => Promise.resolve(true)),
      },
      credentials: {
        set: vi.fn(() => Promise.resolve()),
        has: vi.fn(() => Promise.resolve(false)),
        clear: vi.fn(() => Promise.resolve()),
      },
    },
    emit: (event) => listeners.forEach((listener) => listener(event)),
    unsubscribe,
    setBudget,
  }
}

function event<T extends EventType>(seq: number, type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq, ts: 't', type, payload }
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
    render(
      <SelectionProvider>
        <SessionsProvider>
          <InboxProvider>
            <StatusBar />
          </InboxProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )

    expect(screen.getByText('log —')).toBeInTheDocument()
    expect(screen.getByText('$0.0000')).toBeInTheDocument()
    expect(screen.getByText('cache —')).toBeInTheDocument()
    expect(screen.getByText('budget —')).toBeInTheDocument()
  })

  it('backfills total spend and event count on mount', async () => {
    window.agentinator = stubBridge({ count: 3, total: 1.2345 }).bridge

    render(
      <SelectionProvider>
        <SessionsProvider>
          <InboxProvider>
            <StatusBar />
          </InboxProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('$1.2345')).toBeInTheDocument()
    })
    expect(screen.getByText('log 3 events')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'budgets' })).toBeInTheDocument()
  })

  it('accumulates spend and cache health live from cost events (global, not per-session)', async () => {
    const stub = stubBridge({ total: 1 })
    window.agentinator = stub.bridge

    render(
      <SelectionProvider>
        <SessionsProvider>
          <InboxProvider>
            <StatusBar />
          </InboxProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('$1.0000')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(event(2, 'agent.text', { sessionId: 's', text: 'hi' }))
      stub.emit(cost(3, 0.5))
    })

    expect(screen.getByText('$1.5000')).toBeInTheDocument()
    expect(screen.getByText('cache 75%')).toBeInTheDocument()
    expect(screen.getByText('log 3 events')).toBeInTheDocument()
    // The status bar is global — no per-session dollar chip.
    expect(screen.queryByText(/session \$/)).not.toBeInTheDocument()
  })

  it('opens the budget panel and edits a time-window cap', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(
      <SelectionProvider>
        <SessionsProvider>
          <InboxProvider>
            <StatusBar />
          </InboxProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'budgets' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'budgets' }))
    expect(screen.getByRole('dialog', { name: 'Budget settings' })).toBeInTheDocument()

    const dayInput = screen.getByRole('spinbutton', { name: 'Day budget in dollars' })
    await user.type(dayInput, '20')
    await user.keyboard('{Enter}')

    expect(stub.setBudget).toHaveBeenCalledWith('day', 20)

    await user.click(screen.getByRole('button', { name: 'Close budgets' }))
    expect(screen.queryByRole('dialog', { name: 'Budget settings' })).not.toBeInTheDocument()
  })

  it('opens the API keys panel', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(
      <SelectionProvider>
        <SessionsProvider>
          <InboxProvider>
            <StatusBar />
          </InboxProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'keys' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'keys' }))
    expect(screen.getByRole('dialog', { name: 'API keys' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close API keys' }))
    expect(screen.queryByRole('dialog', { name: 'API keys' })).not.toBeInTheDocument()
  })

  it('shows the plan gauge (incl. per-model windows) and marks spend as an estimate', async () => {
    const stub = stubBridge({ total: 2.3 })
    window.agentinator = stub.bridge

    render(
      <SelectionProvider>
        <SessionsProvider>
          <InboxProvider>
            <StatusBar />
          </InboxProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )
    await waitFor(() => {
      expect(screen.getByText('$2.3000')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(
        event(10, 'account.usage', {
          sessionId: 's',
          mode: 'subscription',
          plan: null, // an unnamed plan still renders
          windows: [
            { key: 'five_hour', label: 'Session · 5h', utilization: 11, resetsAt: null },
            { key: 'seven_day', label: 'Weekly', utilization: 13, resetsAt: null },
            // A per-model window has no short alias — its key shows through.
            { key: 'weekly_opus', label: 'Weekly · Opus', utilization: 20, resetsAt: null },
          ],
          overage: null,
          sessionCostUsd: 0.5,
        }),
      )
    })

    expect(screen.getByLabelText('Plan usage')).toHaveTextContent(
      '5h 11% · 7d 13% · weekly_opus 20%',
    )
    expect(screen.getByText('est. $2.3000')).toBeInTheDocument()
  })

  it('backfills the plan gauge from the log on mount, surviving a reload', async () => {
    const stub = stubBridge({ total: 2.3 })
    const usageEvent = event(9, 'account.usage', {
      sessionId: 's',
      mode: 'subscription',
      plan: 'Max',
      windows: [{ key: 'five_hour', label: 'Session · 5h', utilization: 42, resetsAt: null }],
      overage: null,
      sessionCostUsd: 1,
    })
    ;(stub.bridge.events.search as ReturnType<typeof vi.fn>).mockResolvedValue([usageEvent])
    window.agentinator = stub.bridge

    render(
      <SelectionProvider>
        <SessionsProvider>
          <InboxProvider>
            <StatusBar />
          </InboxProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )

    // No live event is emitted — the gauge is restored purely from the backfill.
    expect(await screen.findByLabelText('Plan usage')).toHaveTextContent('5h 42%')
    expect(screen.getByText('est. $2.3000')).toBeInTheDocument()
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

    const { unmount } = render(
      <SelectionProvider>
        <SessionsProvider>
          <InboxProvider>
            <StatusBar />
          </InboxProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )
    unmount()
    resolve([9, 9, budgets()])
    await Promise.resolve()

    // Four subscribers — StatusBar, the Sessions + Inbox provider wrappers, and
    // WorktreeCleanup — each clean up on unmount.
    expect(stub.unsubscribe).toHaveBeenCalledTimes(4)
    expect(screen.queryByText('log 9 events')).not.toBeInTheDocument()
  })
})
