// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { reduceSession, SessionsProvider, useSessions } from './sessions'

function ev(type: StoredEvent['type'], payload: object): StoredEvent {
  return { seq: 1, ts: 't', type, payload } as StoredEvent
}

function started(id: string, title: string, providerId?: string): StoredEvent {
  return ev('session.started', { sessionId: id, agentId: 'a', workspaceId: 'w', title, providerId })
}

describe('reduceSession', () => {
  it('adds a session on start, keeping its provider, and ignores a duplicate', () => {
    const one = reduceSession([], started('a', 'A', 'claude'))
    expect(one).toEqual([{ id: 'a', title: 'A', status: 'running', providerId: 'claude' }])
    expect(reduceSession(one, started('a', 'A', 'claude'))).toEqual(one)
  })

  it('flips status on user.message (running) and idle, matching only the right id', () => {
    let list = reduceSession([], started('a', 'A'))
    list = reduceSession(list, ev('session.idle', { sessionId: 'a' }))
    expect(list[0]?.status).toBe('idle')
    list = reduceSession(list, ev('user.message', { sessionId: 'a', text: 'go' }))
    expect(list[0]?.status).toBe('running')
    // An id not in the list leaves everything untouched.
    expect(reduceSession(list, ev('session.idle', { sessionId: 'nope' }))).toEqual(list)
  })

  it('removes a session on end and passes unrelated events through', () => {
    const list = reduceSession([], started('a', 'A'))
    expect(
      reduceSession(list, ev('session.ended', { sessionId: 'a', outcome: 'completed' })),
    ).toEqual([])
    expect(reduceSession(list, ev('cost.usage', { sessionId: 'a' }))).toEqual(list)
  })
})

function Consumer(): React.JSX.Element {
  const { sessions } = useSessions()
  return (
    <ul aria-label="sessions">
      {sessions.map((session) => (
        <li key={session.id}>
          {session.title}:{session.status}
        </li>
      ))}
    </ul>
  )
}

interface Stub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  resolveTail: (events: StoredEvent[]) => void
}

function stubBridge(tail?: StoredEvent[]): Stub {
  let appended: ((event: StoredEvent) => void) | undefined
  let resolveTail: (events: StoredEvent[]) => void = () => undefined
  const tailPromise =
    tail === undefined
      ? new Promise<StoredEvent[]>((resolve) => {
          resolveTail = resolve
        })
      : Promise.resolve(tail)
  return {
    emit: (e) => appended?.(e),
    resolveTail,
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => tailPromise),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
    } as unknown as AgentinatorBridge,
  }
}

afterEach(() => {
  delete window.agentinator
})

describe('SessionsProvider', () => {
  it('provides an empty list without a bridge', () => {
    render(
      <SessionsProvider>
        <Consumer />
      </SessionsProvider>,
    )

    expect(screen.getByLabelText('sessions')).toBeEmptyDOMElement()
  })

  it('seeds from the log tail and folds in live events', async () => {
    const stub = stubBridge([started('a', 'A'), ev('session.idle', { sessionId: 'a' })])
    window.agentinator = stub.bridge

    render(
      <SessionsProvider>
        <Consumer />
      </SessionsProvider>,
    )

    await waitFor(() => {
      expect(screen.getByText('A:idle')).toBeInTheDocument()
    })
    act(() => {
      stub.emit(started('b', 'B'))
    })
    expect(screen.getByText('B:running')).toBeInTheDocument()
  })

  it('ignores a tail that resolves after unmount', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    const { unmount } = render(
      <SessionsProvider>
        <Consumer />
      </SessionsProvider>,
    )
    unmount()
    stub.resolveTail([started('a', 'A')])
    await Promise.resolve()

    expect(screen.queryByText('A:running')).not.toBeInTheDocument()
  })
})

describe('useSessions', () => {
  it('throws when used outside a provider', () => {
    expect(() => render(<Consumer />)).toThrow(/within a SessionsProvider/)
  })
})
