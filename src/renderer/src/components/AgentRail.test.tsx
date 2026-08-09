// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { useSelection } from '../state/selection'
import { SelectionProvider } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { AgentRail } from './AgentRail'

/** Selects an arbitrary id — stands in for the composer selecting a
 * just-launched session before its session.started has arrived. */
function Selector({ id }: { id: string }): React.JSX.Element {
  const { select } = useSelection()
  return (
    <button type="button" onClick={() => select({ kind: 'session', id })}>
      select {id}
    </button>
  )
}

function stubBridge(): { bridge: AgentinatorBridge; emit: (event: StoredEvent) => void } {
  const listeners: ((event: StoredEvent) => void)[] = []
  return {
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
    } as unknown as AgentinatorBridge,
  }
}

function started(sessionId: string, title: string, providerId?: string): StoredEvent {
  return {
    seq: 1,
    ts: 't',
    type: 'session.started',
    payload: { sessionId, agentId: 'a', workspaceId: 'w', title, providerId },
  }
}

function modelEvent(sessionId: string, model: string): StoredEvent {
  return { seq: 1, ts: 't', type: 'session.model', payload: { sessionId, model } } as StoredEvent
}

function renderRail(): void {
  render(
    <SelectionProvider>
      <SessionsProvider>
        <AgentRail />
      </SessionsProvider>
    </SelectionProvider>,
  )
}

afterEach(() => {
  delete window.agentinator
})

describe('AgentRail', () => {
  it('shows an empty rail with no agents', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderRail()

    expect(screen.getByLabelText('No active agents')).toBeInTheDocument()
  })

  it('lists agents and highlights the one you click', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderRail()
    act(() => {
      stub.emit(started('session_a', 'Count files', 'claude'))
      stub.emit(started('session_b', 'Fix header'))
    })

    // The provider shows per agent (capitalized); agents without one omit it.
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Count files/ })).toBeInTheDocument()
    const second = screen.getByRole('button', { name: /Fix header/ })
    await userEvent.click(second)

    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Count files/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('New agent clears the selection', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderRail()
    act(() => {
      stub.emit(started('session_a', 'Count files'))
    })
    await userEvent.click(screen.getByRole('button', { name: /Count files/ }))
    expect(screen.getByRole('button', { name: /Count files/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await userEvent.click(screen.getByRole('button', { name: 'New agent' }))
    expect(screen.getByRole('button', { name: /Count files/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('shows the model beside the vendor, stripping the vendor prefix', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderRail()
    act(() => {
      stub.emit(started('a', 'Task A', 'claude'))
      stub.emit(modelEvent('a', 'claude-opus-4-8'))
      stub.emit(started('b', 'Task B', 'acme'))
      // A model that doesn't carry the vendor prefix is shown as-is.
      stub.emit(modelEvent('b', 'x-9'))
    })

    expect(screen.getByText('Claude · opus-4-8')).toBeInTheDocument()
    expect(screen.getByText('Acme · x-9')).toBeInTheDocument()
  })

  it('keeps a freshly launched agent selected even before it appears in the list', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(
      <SelectionProvider>
        <SessionsProvider>
          <Selector id="session_new" />
          <AgentRail />
        </SessionsProvider>
      </SelectionProvider>,
    )
    act(() => {
      stub.emit(started('session_old', 'Old task'))
    })

    // Select a session that isn't in the list yet (the launch just happened).
    await userEvent.click(screen.getByRole('button', { name: 'select session_new' }))
    // Its session.started arrives a beat later.
    act(() => {
      stub.emit(started('session_new', 'New task'))
    })

    // The new agent stays selected — never yanked to the old one.
    expect(screen.getByRole('button', { name: /New task/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Old task/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
