// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { SessionsProvider } from '../state/sessions'
import { Checkpoints } from './Checkpoints'

function stub(backfill: StoredEvent[] = []): {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  create: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
} {
  const listeners: ((event: StoredEvent) => void)[] = []
  const create = vi.fn(() => Promise.resolve('checkpoint_new'))
  const restore = vi.fn(() => Promise.resolve(true))
  return {
    create,
    restore,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    bridge: {
      events: {
        tail: vi.fn(() => Promise.resolve(backfill)),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          listeners.push(listener)
          return () => undefined
        }),
      },
      checkpoints: { create, restore },
    } as unknown as AgentinatorBridge,
  }
}

function event<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq: 1, ts: 't', type, payload }
}

const started = (sessionId: string, branch?: string): StoredEvent =>
  event('session.started', {
    sessionId,
    agentId: 'a',
    workspaceId: 'w',
    title: 'Task',
    ...(branch === undefined ? {} : { worktree: { repoRoot: '/repo', path: '/wt', branch } }),
  })
const checkpoint = (sessionId: string, checkpointId: string, label: string): StoredEvent =>
  event('checkpoint.created', { sessionId, checkpointId, label, sha: `sha_${checkpointId}` })

function renderCheckpoints(backfill: StoredEvent[] = []): ReturnType<typeof stub> {
  const s = stub(backfill)
  window.agentinator = s.bridge
  render(
    <SessionsProvider>
      <Checkpoints sessionId="s1" />
    </SessionsProvider>,
  )
  return s
}

afterEach(() => {
  delete window.agentinator
})

describe('Checkpoints', () => {
  it('prompts to pick an agent when none is selected', () => {
    window.agentinator = stub().bridge
    render(
      <SessionsProvider>
        <Checkpoints sessionId={null} />
      </SessionsProvider>,
    )
    expect(screen.getByText(/Select an agent/)).toBeInTheDocument()
  })

  it('does nothing without a bridge', () => {
    render(
      <SessionsProvider>
        <Checkpoints sessionId="s1" />
      </SessionsProvider>,
    )
    // No bridge → no sessions → treated as unisolated, and the effect no-ops.
    expect(screen.getByText(/Checkpoints are for isolated agents/)).toBeInTheDocument()
  })

  it('explains that checkpoints need an isolated agent', async () => {
    renderCheckpoints([started('s1')]) // no branch → not isolated
    expect(await screen.findByText(/Checkpoints are for isolated agents/)).toBeInTheDocument()
  })

  it('shows the empty state for an isolated agent with no checkpoints', async () => {
    renderCheckpoints([started('s1', 'agentinator/s1')])
    expect(await screen.findByText(/No checkpoints yet/)).toBeInTheDocument()
  })

  it('lists checkpoints (labelled, with a generic fallback) and takes a new one', async () => {
    const s = renderCheckpoints([
      started('s1', 'agentinator/s1'),
      checkpoint('s1', 'c1', 'before refactor'),
      checkpoint('s1', 'c2', ''), // no label → "Checkpoint 2"
    ])

    expect(await screen.findByText('before refactor')).toBeInTheDocument()
    expect(screen.getByText('Checkpoint 2')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Checkpoint label' }), {
      target: { value: '  trying an idea  ' },
    })
    fireEvent.submit(screen.getByRole('textbox', { name: 'Checkpoint label' }).closest('form')!)

    expect(s.create).toHaveBeenCalledWith('s1', 'trying an idea')
  })

  it('ignores a backfill that resolves after unmount', async () => {
    const s = stub([started('s1', 'agentinator/s1')])
    window.agentinator = s.bridge
    const { unmount } = render(
      <SessionsProvider>
        <Checkpoints sessionId="s1" />
      </SessionsProvider>,
    )
    unmount()
    // The tail promise resolves after unmount → the cancelled guard skips it.
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('appends a checkpoint that arrives live, and rewinds on click', async () => {
    const s = renderCheckpoints([started('s1', 'agentinator/s1')])
    await screen.findByText(/No checkpoints yet/)

    act(() => {
      s.emit(checkpoint('s1', 'c1', 'snapshot'))
      s.emit(checkpoint('other', 'c9', 'not mine')) // ignored — different session
    })

    expect(screen.getByText('snapshot')).toBeInTheDocument()
    expect(screen.queryByText('not mine')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rewind to snapshot' }))
    expect(s.restore).toHaveBeenCalledWith('s1', 'c1', 'sha_c1')
  })
})
