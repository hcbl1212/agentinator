// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { AgentTypesProvider } from '../state/agentTypes'
import { PlanProvider } from '../state/plans'
import { ScrubProvider } from '../state/scrub'
import { useSelection } from '../state/selection'
import { SelectionProvider } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { SkillsProvider } from '../state/skills'
import { Stream } from './Stream'

function renderStream(children?: React.ReactNode): void {
  render(
    <SelectionProvider>
      <SessionsProvider>
        <PlanProvider>
          <ScrubProvider>
            <AgentTypesProvider>
              <SkillsProvider>
                {children}
                <Stream />
              </SkillsProvider>
            </AgentTypesProvider>
          </ScrubProvider>
        </PlanProvider>
      </SessionsProvider>
    </SelectionProvider>,
  )
}

afterEach(() => {
  delete window.agentinator
})

describe('Stream', () => {
  it('prompts to pick an agent when none is selected, and keeps the composer', () => {
    renderStream()

    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Activity timeline' })).toBeInTheDocument()
    expect(screen.getByText(/Select an agent, or start a task below/)).toBeInTheDocument()
    // …and the composer docks at its foot.
    expect(screen.getByLabelText('Composer')).toBeInTheDocument()
    expect(screen.getByText(/Open a workspace to talk to an agent/)).toBeInTheDocument()
  })

  it('scopes the timeline to the highlighted agent', async () => {
    const tail = vi.fn(() =>
      Promise.resolve([
        { seq: 1, ts: 't', type: 'agent.text', payload: { sessionId: 'x', text: 'from X' } },
        { seq: 2, ts: 't', type: 'agent.text', payload: { sessionId: 'y', text: 'from Y' } },
      ] as StoredEvent[]),
    )
    window.agentinator = {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: tail as AgentinatorBridge['events']['tail'],
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn(() => () => undefined),
      },
      agent: { current: vi.fn(() => Promise.resolve({ providerId: 'claude', label: 'Claude' })) },
      approvals: { pending: vi.fn(() => Promise.resolve([])) },
      agentTypes: { list: vi.fn(() => Promise.resolve([])) },
      skills: { list: vi.fn(() => Promise.resolve([])) },
    } as unknown as AgentinatorBridge

    function Selector(): React.JSX.Element {
      const { select } = useSelection()
      return (
        <button type="button" onClick={() => select({ kind: 'session', id: 'x' })}>
          pick x
        </button>
      )
    }

    renderStream(<Selector />)

    // No agent selected: the stream is an empty prompt, showing neither line.
    expect(screen.getByText(/Select an agent, or start a task below/)).toBeInTheDocument()
    expect(screen.queryByText('from Y')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'pick x' }))

    // Scoped to x: only its line shows.
    expect(await screen.findByText('from X')).toBeInTheDocument()
    expect(screen.queryByText('from Y')).not.toBeInTheDocument()
  })

  it('fills the idle slot with the plan canvas once a plan exists', async () => {
    window.agentinator = {
      events: {
        count: vi.fn(() => Promise.resolve(1)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() =>
          Promise.resolve([
            {
              seq: 1,
              ts: 't',
              type: 'plan.created',
              payload: {
                planId: 'pl1',
                title: 'Settings page',
                requirement: 'r',
                tasks: [{ taskId: 'ta', title: 'Scaffold', prompt: 'a', dependsOn: [] }],
              },
            },
          ] as StoredEvent[]),
        ),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn(() => () => undefined),
      },
      agent: { current: vi.fn(() => Promise.resolve({ providerId: 'claude', label: 'Claude' })) },
      approvals: { pending: vi.fn(() => Promise.resolve([])) },
      agentTypes: { list: vi.fn(() => Promise.resolve([])) },
      skills: { list: vi.fn(() => Promise.resolve([])) },
    } as unknown as AgentinatorBridge

    renderStream()

    // The canvas takes the timeline's slot; the composer stays docked below.
    expect(await screen.findByRole('region', { name: 'Plan canvas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trace Scaffold' })).toBeInTheDocument()
    expect(screen.queryByText(/Select an agent, or start a task below/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Composer')).toBeInTheDocument()

    // One text surface at a time: opening a task's card (its editable brief)
    // stands the composer down; closing it brings the composer back.
    fireEvent.click(screen.getByRole('button', { name: 'Trace Scaffold' }))
    expect(screen.getByRole('region', { name: 'Task details: Scaffold' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Composer')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Trace Scaffold' }))
    expect(screen.getByLabelText('Composer')).toBeInTheDocument()
  })

  it('toggles between the last agent’s timeline and the plan canvas', async () => {
    window.agentinator = {
      events: {
        count: vi.fn(() => Promise.resolve(1)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() =>
          Promise.resolve([
            {
              seq: 1,
              ts: 't',
              type: 'plan.created',
              payload: {
                planId: 'pl1',
                title: 'Settings page',
                requirement: 'r',
                tasks: [{ taskId: 'ta', title: 'Scaffold', prompt: 'a', dependsOn: [] }],
              },
            },
          ] as StoredEvent[]),
        ),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn(() => () => undefined),
      },
      agent: { current: vi.fn(() => Promise.resolve({ providerId: 'claude', label: 'Claude' })) },
      approvals: { pending: vi.fn(() => Promise.resolve([])) },
      agentTypes: { list: vi.fn(() => Promise.resolve([])) },
      skills: { list: vi.fn(() => Promise.resolve([])) },
    } as unknown as AgentinatorBridge
    function Selector(): React.JSX.Element {
      const { select } = useSelection()
      return (
        <button type="button" onClick={() => select({ kind: 'session', id: 'x' })}>
          pick x
        </button>
      )
    }

    renderStream(<Selector />)

    // Canvas showing, but no agent has ever been watched — nothing to toggle.
    expect(await screen.findByRole('region', { name: 'Plan canvas' })).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()

    // Watching an agent brings the toggle up, Timeline side active.
    fireEvent.click(screen.getByRole('button', { name: 'pick x' }))
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true')

    // Plan flips back to the canvas; Timeline returns to the SAME agent.
    fireEvent.click(screen.getByRole('tab', { name: 'Plan' }))
    expect(screen.getByRole('region', { name: 'Plan canvas' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }))
    expect(screen.queryByRole('region', { name: 'Plan canvas' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Activity timeline' })).toBeInTheDocument()
  })

  it('restores the composer when an agent is selected while a card is open', async () => {
    window.agentinator = {
      events: {
        count: vi.fn(() => Promise.resolve(1)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() =>
          Promise.resolve([
            {
              seq: 1,
              ts: 't',
              type: 'plan.created',
              payload: {
                planId: 'pl1',
                title: 'Settings page',
                requirement: 'r',
                tasks: [{ taskId: 'ta', title: 'Scaffold', prompt: 'a', dependsOn: [] }],
              },
            },
          ] as StoredEvent[]),
        ),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn(() => () => undefined),
      },
      agent: { current: vi.fn(() => Promise.resolve({ providerId: 'claude', label: 'Claude' })) },
      approvals: { pending: vi.fn(() => Promise.resolve([])) },
      agentTypes: { list: vi.fn(() => Promise.resolve([])) },
      skills: { list: vi.fn(() => Promise.resolve([])) },
    } as unknown as AgentinatorBridge
    function Selector(): React.JSX.Element {
      const { select } = useSelection()
      return (
        <button type="button" onClick={() => select({ kind: 'session', id: 'x' })}>
          pick x
        </button>
      )
    }

    renderStream(<Selector />)

    fireEvent.click(await screen.findByRole('button', { name: 'Trace Scaffold' }))
    expect(screen.queryByLabelText('Composer')).not.toBeInTheDocument()

    // The timeline replaces the canvas — the reply composer must return.
    fireEvent.click(screen.getByRole('button', { name: 'pick x' }))
    expect(screen.getByLabelText('Composer')).toBeInTheDocument()
  })
})
