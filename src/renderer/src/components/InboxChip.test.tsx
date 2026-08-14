// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { InboxProvider, useInbox } from '../state/inbox'
import { SelectionProvider } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { InboxChip } from './InboxChip'

function stub(): { bridge: AgentinatorBridge; emit: (event: StoredEvent) => void } {
  const listeners: ((event: StoredEvent) => void)[] = []
  return {
    emit: (event) => listeners.forEach((listener) => listener(event)),
    bridge: {
      events: {
        tail: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          listeners.push(listener)
          return () => undefined
        }),
      },
      approvals: { pending: vi.fn(() => Promise.resolve([])) },
    } as unknown as AgentinatorBridge,
  }
}

function event<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq: 1, ts: 't', type, payload }
}

const approval = (sessionId: string, requestId: string): StoredEvent =>
  event('approval.requested', { sessionId, requestId, tool: 'Bash', input: {} })

function renderChip(): { emit: (event: StoredEvent) => void } {
  const s = stub()
  window.agentinator = s.bridge
  render(
    <SelectionProvider>
      <SessionsProvider>
        <InboxProvider>
          <InboxChip />
        </InboxProvider>
      </SessionsProvider>
    </SelectionProvider>,
  )
  return s
}

afterEach(() => {
  delete window.agentinator
})

describe('InboxChip', () => {
  it('reads "inbox" with no highlight when nothing is waiting', () => {
    renderChip()
    const chip = screen.getByRole('button', { name: 'inbox' })
    expect(chip.className).not.toContain('has-items')
  })

  it('shows the count and highlights when items arrive', () => {
    const s = renderChip()
    act(() => {
      s.emit(approval('s1', 'r1'))
      s.emit(approval('s2', 'r2'))
    })
    const chip = screen.getByRole('button', { name: 'inbox 2' })
    expect(chip.className).toContain('has-items')
  })

  it('opens and closes the triage panel', () => {
    renderChip()
    fireEvent.click(screen.getByRole('button', { name: 'inbox' }))
    expect(screen.getByRole('dialog', { name: 'Attention inbox' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close inbox' }))
    expect(screen.queryByRole('dialog', { name: 'Attention inbox' })).not.toBeInTheDocument()
  })

  it('throws if useInbox is used outside a provider', () => {
    expect(() => renderHook(() => useInbox())).toThrow('within an InboxProvider')
  })
})
