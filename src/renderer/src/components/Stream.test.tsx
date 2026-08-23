// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { AgentTypesProvider } from '../state/agentTypes'
import { ScrubProvider } from '../state/scrub'
import { useSelection } from '../state/selection'
import { SelectionProvider } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { SkillsProvider } from '../state/skills'
import { Stream } from './Stream'

afterEach(() => {
  delete window.agentinator
})

describe('Stream', () => {
  it('prompts to pick an agent when none is selected, and keeps the composer', () => {
    render(
      <SelectionProvider>
        <SessionsProvider>
          <ScrubProvider>
            <AgentTypesProvider>
              <SkillsProvider>
                <Stream />
              </SkillsProvider>
            </AgentTypesProvider>
          </ScrubProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )

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

    render(
      <SelectionProvider>
        <SessionsProvider>
          <ScrubProvider>
            <AgentTypesProvider>
              <SkillsProvider>
                <Selector />
                <Stream />
              </SkillsProvider>
            </AgentTypesProvider>
          </ScrubProvider>
        </SessionsProvider>
      </SelectionProvider>,
    )

    // No agent selected: the stream is an empty prompt, showing neither line.
    expect(screen.getByText(/Select an agent, or start a task below/)).toBeInTheDocument()
    expect(screen.queryByText('from Y')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'pick x' }))

    // Scoped to x: only its line shows.
    expect(await screen.findByText('from X')).toBeInTheDocument()
    expect(screen.queryByText('from Y')).not.toBeInTheDocument()
  })
})
