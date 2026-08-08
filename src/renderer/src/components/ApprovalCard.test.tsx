// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PendingApproval } from '../../../shared/bridge'
import { ApprovalCard } from './ApprovalCard'

const approval: PendingApproval = {
  requestId: 'approval_1',
  sessionId: 's',
  tool: 'write',
  input: { path: 'src/a.ts' },
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ApprovalCard', () => {
  it('shows the tool call and Approve/Deny before a decision', () => {
    render(<ApprovalCard approval={approval} onResolve={vi.fn()} onUndo={vi.fn()} />)

    expect(screen.getByText('write src/a.ts')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('approves instantly with no countdown', async () => {
    const onResolve = vi.fn()
    const user = userEvent.setup()
    render(<ApprovalCard approval={approval} onResolve={onResolve} onUndo={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Approve' }))

    expect(onResolve).toHaveBeenCalledWith(true)
    // Still showing Approve/Deny (the parent unmounts it on the resolved event).
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.queryByText(/Denying/)).not.toBeInTheDocument()
  })

  it('enters a grace countdown on Deny and reports the decision', () => {
    vi.useFakeTimers()
    const onResolve = vi.fn()
    render(<ApprovalCard approval={approval} onResolve={onResolve} onUndo={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(onResolve).toHaveBeenCalledWith(false)
    expect(screen.getByText(/Denying · 3s/)).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText(/Denying · 1s/)).toBeInTheDocument()
  })

  it('Undo returns to Approve/Deny and reports the undo', async () => {
    const onUndo = vi.fn()
    const user = userEvent.setup()
    render(<ApprovalCard approval={approval} onResolve={vi.fn()} onUndo={onUndo} />)

    await user.click(screen.getByRole('button', { name: 'Deny' }))
    await user.click(screen.getByRole('button', { name: 'Undo' }))

    expect(onUndo).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.queryByText(/Denying/)).not.toBeInTheDocument()
  })

  it('clamps the countdown at zero without going negative', () => {
    vi.useFakeTimers()
    render(<ApprovalCard approval={approval} onResolve={vi.fn()} onUndo={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(screen.getByText(/Denying · 0s/)).toBeInTheDocument()
  })
})
