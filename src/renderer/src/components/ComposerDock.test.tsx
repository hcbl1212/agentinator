// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge, PendingApproval } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { ComposerDock } from './ComposerDock'

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  startTask: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
}

function stubBridge(pending: PendingApproval[] = []): BridgeStub {
  const listeners: ((event: StoredEvent) => void)[] = []
  const startTask = vi.fn(() => Promise.resolve('session_task'))
  const send = vi.fn(() => Promise.resolve())
  const cancel = vi.fn(() => Promise.resolve())
  const resolve = vi.fn(() => Promise.resolve())
  return {
    startTask,
    send,
    cancel,
    resolve,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          listeners.push(listener)
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
  }
}

function sessionEvent(type: StoredEvent['type'], payload: object): StoredEvent {
  return { seq: 1, ts: 't', type, payload } as StoredEvent
}

function requested(requestId: string): StoredEvent {
  return sessionEvent('approval.requested', {
    sessionId: 's',
    requestId,
    tool: 'bash',
    input: { command: 'git push' },
  })
}

async function launchTask(): Promise<void> {
  await userEvent.type(screen.getByRole('textbox', { name: 'Task for Claude' }), 'Do it{Enter}')
  await screen.findByRole('textbox', { name: 'Reply to Claude' })
}

afterEach(() => {
  delete window.agentinator
})

describe('ComposerDock', () => {
  it('shows a placeholder and no composer without a bridge', () => {
    render(<ComposerDock />)

    expect(screen.getByText(/Open a workspace to talk to an agent/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Task for Claude' })).not.toBeInTheDocument()
  })

  it('launches a task from the console prompt and clears it', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    const input = screen.getByRole('textbox', { name: 'Task for Claude' })
    await userEvent.type(input, 'Add a hello util{Enter}')

    expect(stub.startTask).toHaveBeenCalledWith('Add a hello util')
    expect(input).toHaveValue('')
  })

  it('sends on Enter and treats Shift+Enter as a newline, not a send', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    const input = screen.getByRole('textbox', { name: 'Task for Claude' })

    await userEvent.type(input, 'first line')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(stub.startTask).not.toHaveBeenCalled()

    await userEvent.type(input, '{Enter}')
    expect(stub.startTask).toHaveBeenCalledWith('first line')
  })

  it('ignores an empty/whitespace submission', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    const input = screen.getByRole('textbox', { name: 'Task for Claude' })
    await userEvent.type(input, '   {Enter}')

    expect(stub.startTask).not.toHaveBeenCalled()
  })

  it('enters reply mode after a task launches and sends a follow-up to that session', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    await launchTask()

    expect(screen.getByText('Working…')).toBeInTheDocument()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reply to Claude' }),
      'also add tests{Enter}',
    )

    expect(stub.send).toHaveBeenCalledWith('session_task', 'also add tests')
  })

  it('marks the session idle when its turn ends', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    await launchTask()
    act(() => {
      stub.emit(sessionEvent('session.idle', { sessionId: 'session_task' }))
    })

    expect(screen.getByText('Awaiting your reply')).toBeInTheDocument()
  })

  it('renders an agent question as an answerable card and answers via a follow-up', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
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
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(stub.send).toHaveBeenCalledWith('session_task', 'Continue')
    expect(screen.queryByLabelText('Agent question')).not.toBeInTheDocument()
  })

  it('New task cancels the active session and returns to the launcher', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    await launchTask()
    await userEvent.click(screen.getByRole('button', { name: 'New task' }))

    expect(stub.cancel).toHaveBeenCalledWith('session_task')
    expect(screen.getByRole('textbox', { name: 'Task for Claude' })).toBeInTheDocument()
  })

  it('clears the active session and returns to the launcher when the session ends', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    await launchTask()
    act(() => {
      stub.emit(sessionEvent('session.ended', { sessionId: 'session_task', outcome: 'completed' }))
    })

    expect(screen.getByRole('textbox', { name: 'Task for Claude' })).toBeInTheDocument()
  })

  it('ignores session idle, question, and ended events for other sessions', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
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
      // An event outside the handled set flows through untouched.
      stub.emit(sessionEvent('agent.text', { sessionId: 'other', text: 'noise' }))
    })

    expect(screen.getByText('Working…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Agent question')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Reply to Claude' })).toBeInTheDocument()
  })

  it('shows already-pending approvals and resolves them via the bridge', async () => {
    const stub = stubBridge([
      { requestId: 'approval_1', sessionId: 's', tool: 'write', input: { path: 'a.ts' } },
    ])
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    await waitFor(() => {
      expect(screen.getByText('write a.ts')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(stub.resolve).toHaveBeenCalledWith('approval_1', true)
  })

  it('adds live approval requests (deduped) and removes them when resolved', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    await waitFor(() => {
      expect(stub.bridge.approvals.pending).toHaveBeenCalled()
    })

    act(() => {
      stub.emit(requested('approval_9'))
      stub.emit(requested('approval_9'))
    })
    expect(screen.getAllByText('bash git push')).toHaveLength(1)

    act(() => {
      stub.emit(
        sessionEvent('approval.resolved', {
          sessionId: 's',
          requestId: 'approval_9',
          approved: false,
          via: 'user',
        }),
      )
    })
    expect(screen.queryByText('bash git push')).not.toBeInTheDocument()
  })

  it('denying enters a grace window and Undo aborts it', async () => {
    const stub = stubBridge([
      { requestId: 'approval_2', sessionId: 's', tool: 'write', input: { path: 'b.ts' } },
    ])
    window.agentinator = stub.bridge

    render(<ComposerDock />)
    await waitFor(() => {
      expect(screen.getByText('write b.ts')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(stub.resolve).toHaveBeenCalledWith('approval_2', false)

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(stub.bridge.approvals.undo).toHaveBeenCalledWith('approval_2')
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

    const { unmount } = render(<ComposerDock />)
    unmount()
    resolvePending([
      { requestId: 'approval_late', sessionId: 's', tool: 'write', input: { path: 'b.ts' } },
    ])
    await Promise.resolve()

    expect(screen.queryByText('write b.ts')).not.toBeInTheDocument()
  })
})
