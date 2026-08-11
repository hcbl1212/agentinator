// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { formatBytes, WorktreeCleanup } from './WorktreeCleanup'

describe('formatBytes', () => {
  it('formats bytes through GB with one decimal for small values', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024)).toBe('20 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})

function stub(): {
  bridge: AgentinatorBridge
  summary: ReturnType<typeof vi.fn>
  cleanup: ReturnType<typeof vi.fn>
  emit: (event: StoredEvent) => void
} {
  let appended: (event: StoredEvent) => void = () => undefined
  const summary = vi.fn(() => Promise.resolve({ count: 0, bytes: 0 }))
  const cleanup = vi.fn(() => Promise.resolve({ count: 0, bytes: 0 }))
  return {
    summary,
    cleanup,
    emit: (event) => appended(event),
    bridge: {
      worktrees: { summary, cleanup },
      events: {
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
    } as unknown as AgentinatorBridge,
  }
}

const ended: StoredEvent = {
  seq: 1,
  ts: 't',
  type: 'session.ended',
  payload: { sessionId: 's', outcome: 'completed' },
}

afterEach(() => {
  delete window.agentinator
})

describe('WorktreeCleanup', () => {
  it('renders nothing when there are no finished worktrees', async () => {
    const s = stub()
    window.agentinator = s.bridge

    render(<WorktreeCleanup />)

    await waitFor(() => expect(s.summary).toHaveBeenCalled())
    expect(screen.queryByLabelText('Finished worktrees')).not.toBeInTheDocument()
  })

  it('renders nothing without a bridge', () => {
    render(<WorktreeCleanup />)
    expect(screen.queryByLabelText('Finished worktrees')).not.toBeInTheDocument()
  })

  it('shows the count and size (pluralized)', async () => {
    const s = stub()
    s.summary.mockResolvedValue({ count: 2, bytes: 2048 })
    window.agentinator = s.bridge

    render(<WorktreeCleanup />)

    expect(await screen.findByText('⑂ 2 finished worktrees · 2.0 KB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clean up' })).toBeInTheDocument()
  })

  it('uses the singular for a single worktree', async () => {
    const s = stub()
    s.summary.mockResolvedValue({ count: 1, bytes: 500 })
    window.agentinator = s.bridge

    render(<WorktreeCleanup />)

    expect(await screen.findByText('⑂ 1 finished worktree · 500 B')).toBeInTheDocument()
  })

  it('confirms, then removes the worktrees and hides once none remain', async () => {
    const s = stub()
    s.summary
      .mockResolvedValueOnce({ count: 2, bytes: 2048 })
      .mockResolvedValue({ count: 0, bytes: 0 })
    s.cleanup.mockResolvedValue({ count: 2, bytes: 2048 })
    window.agentinator = s.bridge

    render(<WorktreeCleanup />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2 + branches' }))

    await waitFor(() => expect(s.cleanup).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(screen.queryByLabelText('Finished worktrees')).not.toBeInTheDocument(),
    )
  })

  it('shows a busy label while cleaning', async () => {
    const s = stub()
    s.summary.mockResolvedValue({ count: 2, bytes: 2048 })
    let resolveCleanup: (v: { count: number; bytes: number }) => void = () => undefined
    s.cleanup.mockReturnValue(
      new Promise((resolve) => {
        resolveCleanup = resolve
      }),
    )
    window.agentinator = s.bridge

    render(<WorktreeCleanup />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2 + branches' }))

    expect(await screen.findByRole('button', { name: 'Cleaning…' })).toBeDisabled()
    resolveCleanup({ count: 2, bytes: 2048 })
  })

  it('cancels the confirmation without cleaning', async () => {
    const s = stub()
    s.summary.mockResolvedValue({ count: 2, bytes: 2048 })
    window.agentinator = s.bridge

    render(<WorktreeCleanup />)
    fireEvent.click(await screen.findByRole('button', { name: 'Clean up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'Clean up' })).toBeInTheDocument()
    expect(s.cleanup).not.toHaveBeenCalled()
  })

  it('refreshes when an agent finishes', async () => {
    const s = stub()
    s.summary
      .mockResolvedValueOnce({ count: 0, bytes: 0 })
      .mockResolvedValue({ count: 1, bytes: 1024 })
    window.agentinator = s.bridge

    render(<WorktreeCleanup />)
    await waitFor(() => expect(s.summary).toHaveBeenCalledOnce())

    s.emit(ended)

    expect(await screen.findByText('⑂ 1 finished worktree · 1.0 KB')).toBeInTheDocument()
  })

  it('ignores non-end events', async () => {
    const s = stub()
    s.summary.mockResolvedValue({ count: 0, bytes: 0 })
    window.agentinator = s.bridge

    render(<WorktreeCleanup />)
    await waitFor(() => expect(s.summary).toHaveBeenCalledOnce())

    s.emit({ seq: 2, ts: 't', type: 'agent.text', payload: { sessionId: 's', text: 'hi' } })

    expect(s.summary).toHaveBeenCalledOnce() // no extra refresh
  })
})
