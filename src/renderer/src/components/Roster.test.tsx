// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge, PendingApproval } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { Roster } from './Roster'

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  resolve: ReturnType<typeof vi.fn>
  startTask: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function stubBridge(pending: PendingApproval[] = []): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const resolve = vi.fn(() => Promise.resolve())
  const startTask = vi.fn(() => Promise.resolve('session_task'))
  const send = vi.fn(() => Promise.resolve())
  const cancel = vi.fn(() => Promise.resolve())
  return {
    resolve,
    startTask,
    send,
    cancel,
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
      settings: {
        getBudgets: vi.fn(() =>
          Promise.resolve({ session: 5, hour: null, day: null, week: null, month: null }),
        ),
        setBudget: vi.fn(() => Promise.resolve()),
      },
      agent: {
        startDemo: vi.fn(() => Promise.resolve('session_1')),
        startTask: startTask as AgentinatorBridge['agent']['startTask'],
        send: send as AgentinatorBridge['agent']['send'],
        cancel: cancel as AgentinatorBridge['agent']['cancel'],
      },
      approvals: {
        pending: vi.fn(() => Promise.resolve(pending)),
        resolve: resolve as AgentinatorBridge['approvals']['resolve'],
        undo: vi.fn(() => Promise.resolve()),
      },
    },
    emit: (event) => appended?.(event),
  }
}

function requestedEvent(requestId: string, seq: number): StoredEvent {
  return {
    seq,
    ts: 't',
    type: 'approval.requested',
    payload: { sessionId: 's', requestId, tool: 'bash', input: { command: 'git push' } },
  } as StoredEvent
}

function sessionEvent(type: StoredEvent['type'], payload: object): StoredEvent {
  return { seq: 1, ts: 't', type, payload } as StoredEvent
}

/** Launch a task and settle into reply mode on the returned session id. */
async function launchTask(): Promise<void> {
  await userEvent.type(screen.getByRole('textbox', { name: 'Task for Claude' }), 'Do it')
  await userEvent.click(screen.getByRole('button', { name: /Run task/ }))
  await screen.findByRole('textbox', { name: 'Reply to Claude' })
}

afterEach(() => {
  delete window.agentinator
})

describe('Roster', () => {
  it('shows no launcher without a bridge (plain browser/test)', () => {
    render(<Roster />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('No agents yet.')).toBeInTheDocument()
  })

  it('launches a real Claude task with the typed prompt, then clears it', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Roster />)
    const input = screen.getByRole('textbox', { name: 'Task for Claude' })
    const run = screen.getByRole('button', { name: /Run task/ })
    expect(run).toBeDisabled()

    await user.type(input, 'Add a hello util')
    expect(run).toBeEnabled()
    await user.click(run)

    expect(stub.startTask).toHaveBeenCalledWith('Add a hello util')
    expect(screen.getByText(/Task dispatched to Claude/)).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('ignores an empty/whitespace task submission', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Roster />)
    const input = screen.getByRole('textbox', { name: 'Task for Claude' })
    await user.type(input, '   ')
    // Submit via Enter in the form (button stays disabled with only whitespace).
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(stub.startTask).not.toHaveBeenCalled()
  })

  it('starts the mock demo session and confirms dispatch', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Roster />)
    await user.click(screen.getByRole('button', { name: /Run demo/ }))

    expect(stub.bridge.agent.startDemo).toHaveBeenCalledOnce()
    expect(screen.getByText(/Demo dispatched/)).toBeInTheDocument()
  })

  it('shows already-pending approvals and resolves them via the bridge', async () => {
    const stub = stubBridge([
      { requestId: 'approval_1', sessionId: 's', tool: 'write', input: { path: 'a.ts' } },
    ])
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Roster />)
    await waitFor(() => {
      expect(screen.getByText('write a.ts')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(stub.resolve).toHaveBeenCalledWith('approval_1', true)
  })

  it('denying enters a grace window and Undo aborts it', async () => {
    const stub = stubBridge([
      { requestId: 'approval_2', sessionId: 's', tool: 'write', input: { path: 'b.ts' } },
    ])
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Roster />)
    await waitFor(() => {
      expect(screen.getByText('write b.ts')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(stub.resolve).toHaveBeenCalledWith('approval_2', false)

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(stub.bridge.approvals.undo).toHaveBeenCalledWith('approval_2')
  })

  it('adds cards from live requests (deduped) and removes them when resolved', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Roster />)
    await waitFor(() => {
      expect(stub.bridge.approvals.pending).toHaveBeenCalled()
    })

    act(() => {
      stub.emit(requestedEvent('approval_9', 1))
      stub.emit(requestedEvent('approval_9', 1))
    })
    expect(screen.getAllByText('bash git push')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(stub.resolve).toHaveBeenCalledWith('approval_9', false)

    act(() => {
      stub.emit({
        seq: 2,
        ts: 't',
        type: 'approval.resolved',
        payload: { sessionId: 's', requestId: 'approval_9', approved: false, via: 'user' },
      } as StoredEvent)
    })
    expect(screen.queryByText('bash git push')).not.toBeInTheDocument()
  })

  it('ignores unrelated live events for the approvals list', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<Roster />)
    await waitFor(() => {
      expect(stub.bridge.approvals.pending).toHaveBeenCalled()
    })

    act(() => {
      stub.emit({
        seq: 3,
        ts: 't',
        type: 'agent.text',
        payload: { sessionId: 's', text: 'hello' },
      } as StoredEvent)
    })

    expect(screen.queryByText(/Needs approval/)).not.toBeInTheDocument()
  })

  it('enters reply mode after a task launches and sends a follow-up to that session', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<Roster />)
    await launchTask()

    // The one-shot task launcher is gone; the demo button hides in a conversation.
    expect(screen.queryByRole('button', { name: /Run demo/ })).not.toBeInTheDocument()
    expect(screen.getByText('Working…')).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: 'Reply to Claude' }), 'also add tests')
    await userEvent.click(screen.getByRole('button', { name: /Send reply/ }))

    expect(stub.send).toHaveBeenCalledWith('session_task', 'also add tests')
  })

  it('marks the session idle when its turn ends', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<Roster />)
    await launchTask()
    act(() => {
      stub.emit(sessionEvent('session.idle', { sessionId: 'session_task' }))
    })

    expect(screen.getByText('Awaiting your reply')).toBeInTheDocument()
  })

  it('renders an agent question as an answerable card and answers via a follow-up', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<Roster />)
    await launchTask()
    act(() => {
      stub.emit(
        sessionEvent('agent.question', {
          sessionId: 'session_task',
          requestId: 'approval_q',
          questions: [{ question: 'Which approach?', options: ['Continue', 'Restart'] }],
        }),
      )
    })

    expect(screen.getByLabelText('Agent question')).toBeInTheDocument()
    expect(screen.getByText('Which approach?')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(stub.send).toHaveBeenCalledWith('session_task', 'Continue')
    // Answering dismisses the card.
    expect(screen.queryByLabelText('Agent question')).not.toBeInTheDocument()
  })

  it('New task cancels the active session and returns to the task launcher', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<Roster />)
    await launchTask()
    await userEvent.click(screen.getByRole('button', { name: 'New task' }))

    expect(stub.cancel).toHaveBeenCalledWith('session_task')
    expect(screen.getByRole('textbox', { name: 'Task for Claude' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run demo/ })).toBeInTheDocument()
  })

  it('clears the active session and returns to the launcher when the session ends', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<Roster />)
    await launchTask()
    act(() => {
      stub.emit(sessionEvent('session.ended', { sessionId: 'session_task', outcome: 'completed' }))
    })

    expect(screen.getByRole('textbox', { name: 'Task for Claude' })).toBeInTheDocument()
  })

  it('ignores session idle, question, and ended events for other sessions', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<Roster />)
    await launchTask()
    act(() => {
      stub.emit(sessionEvent('session.idle', { sessionId: 'other' }))
      stub.emit(
        sessionEvent('agent.question', {
          sessionId: 'other',
          requestId: 'approval_x',
          questions: [{ question: 'ignored?', options: [] }],
        }),
      )
      stub.emit(sessionEvent('session.ended', { sessionId: 'other', outcome: 'completed' }))
    })

    // The active session is untouched: still running, still in reply mode.
    expect(screen.getByText('Working…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Agent question')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Reply to Claude' })).toBeInTheDocument()
  })

  it('ignores a pending list that resolves after unmount', async () => {
    let resolvePending: (pending: PendingApproval[]) => void = () => undefined
    const stub = stubBridge()
    ;(stub.bridge.approvals.pending as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<PendingApproval[]>((resolve) => {
        resolvePending = resolve
      }),
    )
    window.agentinator = stub.bridge

    const { unmount } = render(<Roster />)
    unmount()
    resolvePending([
      { requestId: 'approval_late', sessionId: 's', tool: 'write', input: { path: 'b.ts' } },
    ])
    await Promise.resolve()

    expect(screen.queryByText('write b.ts')).not.toBeInTheDocument()
  })
})
