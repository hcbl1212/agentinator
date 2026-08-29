// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { InboxProvider } from '../state/inbox'
import { PipelineProvider } from '../state/pipelines'
import { PlanProvider } from '../state/plans'
import { SelectionProvider, useSelection } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { InboxPanel } from './InboxPanel'

function stub(
  backfill: StoredEvent[] = [],
  pending: { requestId: string; sessionId: string; tool: string; input: unknown }[] = [],
): {
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
      approvals: { pending: vi.fn(() => Promise.resolve(pending)) },
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

function renderPanel(
  backfill: StoredEvent[],
  pending: { requestId: string; sessionId: string; tool: string; input: unknown }[] = [],
  onClose = vi.fn(),
): ReturnType<typeof stub> {
  const s = stub(backfill, pending)
  window.agentinator = s.bridge
  render(
    <SelectionProvider>
      <SessionsProvider>
        <PlanProvider>
          <PipelineProvider>
            <InboxProvider>
              <Probe />
              <InboxPanel onClose={onClose} />
            </InboxProvider>
          </PipelineProvider>
        </PlanProvider>
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

  it('ranks items by DAG blockage — critical-path decisions above leaf noise', async () => {
    renderPanel([
      started('s_leaf', 'Polish docs'),
      started('s_root', 'Design schema'),
      // The plan: the root task gates two dependents; the leaf gates none.
      // s_leaf's question arrives FIRST — weight must beat arrival order.
      event('plan.created', {
        planId: 'pl1',
        title: 'Data layer',
        requirement: 'r',
        tasks: [
          { taskId: 'root', title: 'Root', prompt: 'p', dependsOn: [] },
          { taskId: 'mid', title: 'Mid', prompt: 'p', dependsOn: ['root'] },
          { taskId: 'tip', title: 'Tip', prompt: 'p', dependsOn: ['mid'] },
          { taskId: 'leaf', title: 'Leaf', prompt: 'p', dependsOn: [] },
        ],
      }),
      event('plan.task.dispatched', { planId: 'pl1', taskId: 'leaf', sessionId: 's_leaf' }),
      event('plan.task.dispatched', { planId: 'pl1', taskId: 'root', sessionId: 's_root' }),
      question('s_leaf', 'r1', 'Oxford commas?'),
      question('s_root', 'r2', 'UUID or serial keys?'),
    ])

    const items = await screen.findAllByRole('button', { name: /Go to/ })
    expect(items[0]).toHaveAccessibleName('Go to Design schema')
    expect(items[1]).toHaveAccessibleName('Go to Polish docs')
    // The weight is visible, and only where it exists.
    expect(items[0]).toHaveTextContent('blocks 2')
    expect(items[1]).not.toHaveTextContent(/blocks/)
  })

  it('lists pending approvals (from the broker) and questions (from the log)', async () => {
    renderPanel(
      [started('s1', 'Fix the header'), question('s1', 'r2', 'Which colour?')],
      [{ requestId: 'r1', sessionId: 's1', tool: 'Bash', input: {} }],
    )

    expect(await screen.findByText('wants to run Bash')).toBeInTheDocument()
    expect(screen.getByText('Which colour?')).toBeInTheDocument()
    expect(screen.getAllByText('Fix the header')).toHaveLength(2)
  })

  it('falls back to a generic name for an unknown agent', async () => {
    renderPanel([], [{ requestId: 'r1', sessionId: 'ghost', tool: 'Write', input: {} }])
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

  it('does not duplicate a backfill item that already arrived live', async () => {
    let resolveTail: (events: StoredEvent[]) => void = () => undefined
    // One shared deferred promise so resolving it settles every caller's tail
    // (both the Sessions and Inbox providers back-fill from it).
    const tailPromise = new Promise<StoredEvent[]>((resolve) => {
      resolveTail = resolve
    })
    const listeners: ((e: StoredEvent) => void)[] = []
    window.agentinator = {
      events: {
        tail: vi.fn(() => tailPromise),
        onAppended: vi.fn((listener: (e: StoredEvent) => void) => {
          listeners.push(listener)
          return () => undefined
        }),
      },
      approvals: {
        pending: vi.fn(() =>
          Promise.resolve([
            { requestId: 'r1', sessionId: 's1', tool: 'Bash', input: {} }, // same as the live one
            { requestId: 'r2', sessionId: 's1', tool: 'Edit', input: {} }, // new — proves merge ran
          ]),
        ),
      },
    } as unknown as AgentinatorBridge
    render(
      <SelectionProvider>
        <SessionsProvider>
          <PlanProvider>
            <PipelineProvider>
              <InboxProvider>
                <InboxPanel onClose={vi.fn()} />
              </InboxProvider>
            </PipelineProvider>
          </PlanProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )

    // The r1 approval arrives live before the backfill (tail) resolves.
    act(() => {
      listeners.forEach((listener) => listener(approval('s1', 'r1', 'Bash')))
    })
    act(() => {
      resolveTail([])
    })

    // The backfill merges in the new r2, and doesn't double-list the r1 it
    // already had live.
    expect(await screen.findByText('wants to run Edit')).toBeInTheDocument()
    expect(screen.getAllByText('wants to run Bash')).toHaveLength(1)
  })

  it('jumps to the agent and closes when an item is clicked', async () => {
    const onClose = vi.fn()
    renderPanel(
      [started('s1', 'Fix the header')],
      [{ requestId: 'r1', sessionId: 's1', tool: 'Bash', input: {} }],
      onClose,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Go to Fix the header' }))

    expect(selection).toEqual({ kind: 'session', id: 's1' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
