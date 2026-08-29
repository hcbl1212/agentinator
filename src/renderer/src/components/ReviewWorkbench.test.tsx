// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { PipelineProvider } from '../state/pipelines'
import { PlanProvider } from '../state/plans'
import { SelectionProvider, useSelection } from '../state/selection'
import { finalText, ReviewWorkbench } from './ReviewWorkbench'

function event<T extends EventType>(type: T, payload: EventPayloads[T], seq = 1): StoredEvent {
  return { seq, ts: 't', type, payload }
}

const diffed = (sessionId: string, path: string, patch: string, seq: number): StoredEvent =>
  event('file.diffed', { sessionId, path, additions: 1, deletions: 0, patch }, seq)

const TWO_STAGES = [
  { name: 'Plan', prompt: 'p' },
  { name: 'Implement', prompt: 'i' },
]

/** A finished two-stage pipeline (Plan s0 → Implement s1) paused at the
 * review boundary. Both stages touched schema.sql — s1's version must win —
 * and s1 alone touched api.ts. */
const FINISHED: StoredEvent[] = [
  event('pipeline.created', { pipelineId: 'pl1', title: 'Design the schema', stages: TWO_STAGES }),
  event('pipeline.stage.started', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }),
  event('pipeline.stage.completed', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }),
  event('pipeline.stage.started', { pipelineId: 'pl1', stageIndex: 1, sessionId: 's1' }),
  event('pipeline.stage.completed', { pipelineId: 'pl1', stageIndex: 1, sessionId: 's1' }),
  event('pipeline.completed', { pipelineId: 'pl1' }),
]

/** The same pipeline earlier in life: stage 0 finished, paused at the gate. */
const GATED: StoredEvent[] = [
  event('pipeline.created', { pipelineId: 'pl2', title: 'Gated', stages: TWO_STAGES }),
  event('pipeline.stage.started', { pipelineId: 'pl2', stageIndex: 0, sessionId: 's0' }),
  event('pipeline.stage.completed', { pipelineId: 'pl2', stageIndex: 0, sessionId: 's0' }),
]

function stub(backfill: StoredEvent[] = FINISHED): {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  promote: ReturnType<typeof vi.fn>
} {
  const promote = vi.fn(() => Promise.resolve(true))
  let appended: (event: StoredEvent) => void = () => undefined
  const bySession = new Map<string, StoredEvent[]>([
    [
      's0',
      [
        event('agent.text', { sessionId: 's0', text: 'First draft.' }),
        event('agent.text', { sessionId: 's0', text: 'The plan:\n1. schema' }),
      ],
    ],
    ['s1', []],
  ])
  const diffs = new Map<string, StoredEvent[]>([
    ['s0', [diffed('s0', 'db/schema.sql', '+-- v1', 5)]],
    [
      's1',
      [diffed('s1', 'db/schema.sql', '+-- v2 final', 9), diffed('s1', 'src/api.ts', '+api', 10)],
    ],
  ])
  return {
    emit: (e) => appended(e),
    promote,
    bridge: {
      events: {
        tail: vi.fn(() => Promise.resolve(backfill)),
        onAppended: vi.fn((listener: (e: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
        bySession: vi.fn((sessionId: string) => Promise.resolve(bySession.get(sessionId) ?? [])),
        diffs: vi.fn((sessionId: string) => Promise.resolve(diffs.get(sessionId) ?? [])),
      },
      pipelines: {
        continue: vi.fn(() => Promise.resolve()),
        revise: vi.fn(() => Promise.resolve()),
        approve: vi.fn(() => Promise.resolve()),
      },
      planner: { promote },
    } as unknown as AgentinatorBridge,
  }
}

let selection: unknown
function Probe(): null {
  selection = useSelection().selection
  return null
}

function renderBench(pipelineId = 'pl1'): void {
  render(
    <SelectionProvider>
      <PipelineProvider>
        <PlanProvider>
          <Probe />
          <ReviewWorkbench pipelineId={pipelineId} />
        </PlanProvider>
      </PipelineProvider>
    </SelectionProvider>,
  )
}

afterEach(() => {
  delete window.agentinator
  selection = undefined
})

describe('finalText', () => {
  it('returns the last agent.text, or empty with none', () => {
    expect(
      finalText([
        event('agent.text', { sessionId: 's', text: 'one' }),
        event('agent.text', { sessionId: 's', text: 'two' }),
      ]),
    ).toBe('two')
    expect(finalText([event('session.idle', { sessionId: 's' })])).toBe('')
  })
})

describe('ReviewWorkbench', () => {
  it('says so when the pipeline was cleared', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderBench('pl_gone')
    expect(screen.getByText(/This pipeline is gone/)).toBeInTheDocument()
  })

  it('renders nothing to judge without a bridge (and no crash)', () => {
    renderBench() // no window.agentinator — providers and the report load no-op
    expect(screen.getByText(/This pipeline is gone/)).toBeInTheDocument()
  })

  it('shows a just-created pipeline bare: no stages, no diff, no decision yet', async () => {
    const s = stub([
      event('pipeline.created', { pipelineId: 'pl3', title: 'Fresh', stages: TWO_STAGES }),
    ])
    window.agentinator = s.bridge
    renderBench('pl3')

    expect(await screen.findByText('Fresh')).toBeInTheDocument()
    expect(screen.getByText('in flight')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /Stage:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Combined diff' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue|Approve/ })).not.toBeInTheDocument()
  })

  it('shows each stage’s reasoning and the combined diff (later stages win)', async () => {
    const s = stub()
    window.agentinator = s.bridge
    renderBench()

    // Stage reasoning: the LAST words of s0; s1 wrote nothing. (The sections
    // render at once; the reasoning arrives with the per-stage reports.)
    await screen.findByText(/The plan:/)
    expect(screen.getByRole('region', { name: 'Stage: Plan' })).toHaveTextContent('The plan:')
    expect(screen.getByRole('region', { name: 'Stage: Implement' })).toHaveTextContent(
      '(no written output)',
    )

    // Combined diff: one section per file, s1's schema version, s1's api file.
    const diff = screen.getByRole('region', { name: 'Combined diff' })
    expect(diff).toHaveTextContent('db/schema.sql')
    expect(diff).toHaveTextContent('-- v2 final')
    expect(diff).not.toHaveTextContent('-- v1')
    expect(diff).toHaveTextContent('src/api.ts')
  })

  it('carries the review decision: request changes or approve', async () => {
    const s = stub()
    window.agentinator = s.bridge
    renderBench()
    await screen.findByRole('region', { name: 'Stage: Plan' })

    // Blank feedback does nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    expect(s.bridge.pipelines.revise).not.toHaveBeenCalled()
    const input = screen.getByRole('textbox', { name: 'Request changes on this pipeline' })
    fireEvent.change(input, { target: { value: 'add a consent table' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    expect(s.bridge.pipelines.revise).toHaveBeenCalledWith('pl1', 's1', 'add a consent table')
    expect(input).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: 'Approve ✓' }))
    expect(s.bridge.pipelines.approve).toHaveBeenCalledWith('pl1')
  })

  it('carries the gate mid-flight: revise or continue the paused stage', async () => {
    const s = stub(GATED)
    window.agentinator = s.bridge
    renderBench('pl2')

    fireEvent.click(await screen.findByRole('button', { name: 'Continue → Implement' }))
    expect(s.bridge.pipelines.continue).toHaveBeenCalledWith('pl2', 's0')
    const revise = screen.getByRole('textbox', { name: 'Revision feedback for Plan' })
    fireEvent.change(revise, { target: { value: 'shorter plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    expect(s.bridge.pipelines.revise).toHaveBeenCalledWith('pl2', 's0', 'shorter plan')
  })

  it('shows an approved pipeline as settled — no decision left to make', async () => {
    const s = stub([...FINISHED, event('pipeline.approved', { pipelineId: 'pl1' })])
    window.agentinator = s.bridge
    renderBench()

    expect(await screen.findByText('approved')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve ✓' })).not.toBeInTheDocument()
  })

  it('ignores stage reports that resolve after unmount', async () => {
    const s = stub()
    window.agentinator = s.bridge
    const { unmount } = render(
      <SelectionProvider>
        <PipelineProvider>
          <PlanProvider>
            <ReviewWorkbench pipelineId="pl1" />
          </PlanProvider>
        </PipelineProvider>
      </SelectionProvider>,
    )
    unmount()
    await new Promise((resolve) => setTimeout(resolve))
  })

  it('promotes a stage’s written plan into the pipelined task’s place', async () => {
    // The pipeline was launched from plan task tt — promotion applies.
    const s = stub([
      ...FINISHED,
      event('plan.created', {
        planId: 'plx',
        title: 'Parent plan',
        requirement: 'r',
        tasks: [{ taskId: 'tt', title: 'Big task', prompt: 'big', dependsOn: [] }],
      }),
      event('plan.task.pipelined', { planId: 'plx', taskId: 'tt', pipelineId: 'pl1' }),
    ])
    window.agentinator = s.bridge
    renderBench()
    await screen.findByText(/The plan:/)

    // Only stages with written output offer promotion (Implement wrote none).
    expect(
      screen.queryByRole('button', { name: 'Promote Implement output to plan tasks' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Promote Plan output to plan tasks' }))
    expect(s.promote).toHaveBeenCalledWith('pl1', 'The plan:\n1. schema')

    // Success clears the selection — the canvas shows the new sub-graph.
    await screen.findByText(/The plan:/) // still mounted until state settles
    expect(selection).toBeNull()
  })

  it('keeps the workbench up when promotion is refused or fails', async () => {
    const s = stub([
      ...FINISHED,
      event('plan.created', {
        planId: 'plx',
        title: 'Parent plan',
        requirement: 'r',
        tasks: [{ taskId: 'tt', title: 'Big task', prompt: 'big', dependsOn: [] }],
      }),
      event('plan.task.pipelined', { planId: 'plx', taskId: 'tt', pipelineId: 'pl1' }),
    ])
    s.promote.mockReturnValueOnce(Promise.resolve(false))
    window.agentinator = s.bridge
    renderBench()
    await screen.findByText(/The plan:/)

    fireEvent.click(screen.getByRole('button', { name: 'Promote Plan output to plan tasks' }))
    await screen.findByRole('button', { name: 'Promote Plan output to plan tasks' })

    // Refused: nothing cleared, the button is usable again — and a rejecting
    // bridge behaves the same way.
    const failure = Promise.reject(new Error('provider down'))
    failure.catch(() => undefined)
    s.promote.mockReturnValueOnce(failure)
    fireEvent.click(screen.getByRole('button', { name: 'Promote Plan output to plan tasks' }))
    await screen.findByRole('button', { name: 'Promote Plan output to plan tasks' })
    expect(screen.getByRole('button', { name: 'Promote Plan output to plan tasks' })).toBeEnabled()
  })

  it('offers no promotion on a pipeline no plan task launched', async () => {
    const s = stub()
    window.agentinator = s.bridge
    renderBench()
    await screen.findByText(/The plan:/)

    expect(screen.queryByRole('button', { name: /Promote/ })).not.toBeInTheDocument()
  })

  it('jumps to a stage transcript, and close clears the selection', async () => {
    const s = stub()
    window.agentinator = s.bridge
    renderBench()

    fireEvent.click(await screen.findByRole('button', { name: 'Open Plan transcript' }))
    expect(selection).toEqual({ kind: 'session', id: 's0' })

    fireEvent.click(screen.getByRole('button', { name: 'Close review' }))
    expect(selection).toBeNull()
  })
})
