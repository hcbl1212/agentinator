// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { SelectionProvider } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { AgentRail } from './AgentRail'

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
  } as StoredEvent
}

function ended(sessionId: string): StoredEvent {
  return {
    seq: 1,
    ts: 't',
    type: 'session.ended',
    payload: { sessionId, outcome: 'completed' },
  } as StoredEvent
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

  it('follows the selection to the newest agent when the highlighted one ends', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderRail()
    act(() => {
      stub.emit(started('session_a', 'Count files'))
      stub.emit(started('session_b', 'Fix header'))
    })
    await userEvent.click(screen.getByRole('button', { name: /Count files/ }))

    act(() => {
      stub.emit(ended('session_a'))
    })

    // A is gone; the selection follows to the newest remaining agent, B.
    expect(screen.getByRole('button', { name: /Fix header/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('clears the selection when the last agent ends', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderRail()
    act(() => {
      stub.emit(started('session_a', 'Count files'))
    })
    await userEvent.click(screen.getByRole('button', { name: /Count files/ }))

    act(() => {
      stub.emit(ended('session_a'))
    })

    expect(screen.getByLabelText('No active agents')).toBeInTheDocument()
  })
})
