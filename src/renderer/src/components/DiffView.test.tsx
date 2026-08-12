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
  }
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
        startDemo: vi.fn(() => Promise.resolve('s')),
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
      credentials: {
        set: vi.fn(() => Promise.resolve()),
        has: vi.fn(() => Promise.resolve(false)),
        clear: vi.fn(() => Promise.resolve()),
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
  it('prompts to pick an agent when none is selected', () => {
    window.agentinator = stubBridge([diffEvent('a.ts', '+x', 1)]).bridge

    render(<DiffView sessionId={null} />)

    expect(screen.getByText(/Select an agent to see its changes/)).toBeInTheDocument()
    // No fetch happens with no agent selected.
    expect(window.agentinator.events.diffs).not.toHaveBeenCalled()
  })

  it('shows the empty state for a selected agent without a bridge', () => {
    render(<DiffView sessionId="s" />)

    expect(screen.getByText(/File changes appear here/)).toBeInTheDocument()
  })

  it('renders the selected agent’s per-file diffs with colored lines and stats', async () => {
    const stub = stubBridge([diffEvent('src/a.ts', '@@ -1 +1 @@\n-old\n+new', 1, 1)])
    window.agentinator = stub.bridge

    render(<DiffView sessionId="s" />)

    await waitFor(() => {
      expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    })
    expect(stub.bridge.events.diffs).toHaveBeenCalledWith('s')
    expect(screen.getByText('+new')).toHaveClass('diff-add')
    expect(screen.getByText('-old')).toHaveClass('diff-del')
    expect(screen.getByText('@@ -1 +1 @@')).toHaveClass('diff-hunk')
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('updates live for its own session and ignores other sessions and non-diffs', async () => {
    const stub = stubBridge([diffEvent('a.ts', '+one', 1)])
    window.agentinator = stub.bridge

    render(<DiffView sessionId="s" />)
    await waitFor(() => {
      expect(screen.getByText('+one')).toBeInTheDocument()
    })

    act(() => {
      stub.emit(diffEvent('a.ts', '+two', 2))
      // A diff for another agent must not appear here.
      stub.emit({
        seq: 3,
        ts: 't',
        type: 'file.diffed',
        payload: { sessionId: 'other', path: 'z.ts', additions: 1, deletions: 0, patch: '+zzz' },
      })
      // A non-diff event is ignored.
      stub.emit({
        seq: 4,
        ts: 't',
        type: 'agent.text',
        payload: { sessionId: 's', text: 'x' },
      })
    })

    expect(screen.queryByText('+one')).not.toBeInTheDocument()
    expect(screen.getByText('+two')).toBeInTheDocument()
    expect(screen.queryByText('+zzz')).not.toBeInTheDocument()
  })

  it('ignores a late load after unmount', async () => {
    let resolve: (events: StoredEvent[]) => void = () => undefined
    const stub = stubBridge([])
    ;(stub.bridge.events.diffs as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<StoredEvent[]>((r) => {
        resolve = r
      }),
    )
    window.agentinator = stub.bridge

    const { unmount } = render(<DiffView sessionId="s" />)
    unmount()
    resolve([diffEvent('late.ts', '+late', 1)])
    await Promise.resolve()

    expect(stub.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.queryByText('+late')).not.toBeInTheDocument()
  })
})
