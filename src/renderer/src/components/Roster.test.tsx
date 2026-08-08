// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge, PendingApproval } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { Roster } from './Roster'

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  resolve: ReturnType<typeof vi.fn>
}

function stubBridge(pending: PendingApproval[] = []): BridgeStub {
  let appended: ((event: StoredEvent) => void) | undefined
  const resolve = vi.fn(() => Promise.resolve())
  return {
    resolve,
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
      agent: {
        startDemo: vi.fn(() => Promise.resolve('session_1')),
        cancel: vi.fn(() => Promise.resolve()),
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

afterEach(() => {
  delete window.agentinator
})

describe('Roster', () => {
  it('hides the demo button without a bridge (plain browser/test)', () => {
    render(<Roster />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('starts the demo session and confirms dispatch', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const user = userEvent.setup()

    render(<Roster />)
    await user.click(screen.getByRole('button', { name: /Run demo agent/ }))

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

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(stub.bridge.approvals.undo).toHaveBeenCalledWith('approval_1')
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
