// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { InboxProvider } from '../state/inbox'
import { SelectionProvider, useSelection } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { InboxPanel } from './InboxPanel'

function stub(backfill: StoredEvent[] = []): {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
} {
  const listeners: ((event: StoredEvent) => void)[] = []
  return {
    emit: (event) => listeners.forEach((listener) => listener(event)),
    bridge: {
      events: {
        tail: vi.fn(() => Promise.resolve(backfill)),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          listeners.push(listener)
          return () => undefined
        }),
      },
    } as unknown as AgentinatorBridge,
  }
}

function event<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq: 1, ts: 't', type, payload }
}

const started = (sessionId: string, title: string): StoredEvent =>
  event('session.started', { sessionId, agentId: 'a', workspaceId: 'w', title })
const approval = (sessionId: string, requestId: string, tool: string): StoredEvent =>
  event('approval.requested', { sessionId, requestId, tool, input: {} })
const question = (sessionId: string, requestId: string, q: string): StoredEvent =>
  event('agent.question', { sessionId, requestId, questions: [{ question: q, options: ['a'] }] })

let selection: unknown
function Probe(): null {
  selection = useSelection().selection
  return null
}

function renderPanel(backfill: StoredEvent[], onClose = vi.fn()): ReturnType<typeof stub> {
  const s = stub(backfill)
  window.agentinator = s.bridge
  render(
    <SelectionProvider>
      <SessionsProvider>
        <InboxProvider>
          <Probe />
          <InboxPanel onClose={onClose} />
        </InboxProvider>
      </SessionsProvider>
    </SelectionProvider>,
  )
  return s
}

afterEach(() => {
  delete window.agentinator
  selection = undefined
})

describe('InboxPanel', () => {
  it('shows the empty state when nothing needs you', () => {
    renderPanel([])
    expect(screen.getByText(/Nothing needs you/)).toBeInTheDocument()
  })

  it('lists pending approvals and questions with the agent title', async () => {
    renderPanel([
      started('s1', 'Fix the header'),
      approval('s1', 'r1', 'Bash'),
      question('s1', 'r2', 'Which colour?'),
    ])

    expect(await screen.findByText('wants to run Bash')).toBeInTheDocument()
    expect(screen.getByText('Which colour?')).toBeInTheDocument()
    expect(screen.getAllByText('Fix the header')).toHaveLength(2)
  })

  it('falls back to a generic name for an unknown agent', async () => {
    renderPanel([approval('ghost', 'r1', 'Write')])
    expect(await screen.findByText('An agent')).toBeInTheDocument()
  })

  it('labels a question that carries no text generically', async () => {
    renderPanel([
      started('s1', 'Task'),
      event('agent.question', { sessionId: 's1', requestId: 'r1', questions: [] }),
    ])
    expect(await screen.findByText('a question')).toBeInTheDocument()
  })

  it('clears items as they are handled or the agent ends', () => {
    const s = renderPanel([])

    act(() => {
      s.emit(started('s1', 'Task'))
      s.emit(approval('s1', 'r1', 'Bash'))
      s.emit(approval('s1', 'r1', 'Bash')) // dupe ignored
      s.emit(question('s1', 'r2', 'Pick'))
      s.emit(question('s1', 'r2', 'Pick')) // dupe ignored
      s.emit(event('agent.text', { sessionId: 's1', text: 'noise' })) // unrelated
    })
    expect(screen.getByText('wants to run Bash')).toBeInTheDocument()
    expect(screen.getAllByText('Pick')).toHaveLength(1)

    // Approval resolves; replying answers the question.
    act(() => {
      s.emit(
        event('approval.resolved', {
          sessionId: 's1',
          requestId: 'r1',
          approved: true,
          via: 'user',
        }),
      )
      s.emit(event('user.message', { sessionId: 's1', text: 'blue' }))
    })
    expect(screen.queryByText('wants to run Bash')).not.toBeInTheDocument()
    expect(screen.queryByText('Pick')).not.toBeInTheDocument()

    // A new approval, then the whole agent ends → gone.
    act(() => {
      s.emit(approval('s1', 'r3', 'Edit'))
    })
    expect(screen.getByText('wants to run Edit')).toBeInTheDocument()
    act(() => {
      s.emit(event('session.ended', { sessionId: 's1', outcome: 'cancelled' }))
    })
    expect(screen.queryByText('wants to run Edit')).not.toBeInTheDocument()
  })

  it('jumps to the agent and closes when an item is clicked', async () => {
    const onClose = vi.fn()
    renderPanel([started('s1', 'Fix the header'), approval('s1', 'r1', 'Bash')], onClose)

    fireEvent.click(await screen.findByRole('button', { name: 'Go to Fix the header' }))

    expect(selection).toEqual({ kind: 'session', id: 's1' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
