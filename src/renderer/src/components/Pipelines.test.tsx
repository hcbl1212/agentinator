// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type {
  EventPayloads,
  EventType,
  PipelineStageSpec,
  StoredEvent,
} from '../../../shared/events'
import { PipelineProvider, usePipelines } from '../state/pipelines'
import { SelectionProvider, useSelection } from '../state/selection'
import { Pipelines } from './Pipelines'

function stub(backfill: StoredEvent[] = []): {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  remove: ReturnType<typeof vi.fn>
  continueStage: ReturnType<typeof vi.fn>
} {
  let appended: (event: StoredEvent) => void = () => undefined
  const remove = vi.fn(() => Promise.resolve())
  const continueStage = vi.fn(() => Promise.resolve())
  return {
    emit: (event) => appended(event),
    remove,
    continueStage,
    bridge: {
      events: {
        tail: vi.fn(() => Promise.resolve(backfill)),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
      pipelines: {
        create: vi.fn(() => Promise.resolve('pl_new')),
        continue: continueStage,
        remove,
      },
    } as unknown as AgentinatorBridge,
  }
}

function event<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq: 1, ts: 't', type, payload }
}

const STAGES: PipelineStageSpec[] = [
  { name: 'Plan', prompt: 'p' },
  { name: 'Implement', prompt: 'i' },
  { name: 'Review', prompt: 'r' },
]

function created(pipelineId: string, title = 'Add logout'): StoredEvent {
  return event('pipeline.created', { pipelineId, title, stages: STAGES })
}

function renderPipelines(): void {
  render(
    <SelectionProvider>
      <PipelineProvider>
        <Pipelines />
      </PipelineProvider>
    </SelectionProvider>,
  )
}

afterEach(() => {
  delete window.agentinator
})

describe('Pipelines', () => {
  it('shows the empty state with no pipelines (and without a bridge)', () => {
    renderPipelines() // no window.agentinator — the provider effect returns early
    expect(screen.getByText(/No pipelines yet/)).toBeInTheDocument()
  })

  it('backfills a pipeline from the log as pending stage chips with a count', async () => {
    window.agentinator = stub([created('pl1')]).bridge

    renderPipelines()

    expect(await screen.findByText('Add logout')).toBeInTheDocument()
    expect(screen.getByLabelText('Plan — pending')).toBeInTheDocument()
    expect(screen.getByLabelText('Implement — pending')).toBeInTheDocument()
    expect(screen.getByLabelText('Review — pending')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    // A pending (unlaunched) stage isn't clickable yet.
    expect(
      screen.queryByRole('button', { name: 'Plan — pending — select its agent' }),
    ).not.toBeInTheDocument()
  })

  it('clears a pipeline via its remove button, and folds out a removed one', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPipelines()

    act(() => {
      s.emit(created('pl1', 'First'))
      s.emit(created('pl2', 'Second'))
    })
    expect(screen.getByText('First')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear pipeline First' }))
    expect(s.remove).toHaveBeenCalledWith('pl1')

    // The removed event folds it out of the list; the other stays.
    act(() => {
      s.emit(event('pipeline.removed', { pipelineId: 'pl1' }))
    })
    expect(screen.queryByText('First')).not.toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
  })

  it('advances stage chips through running, done, and failed as events arrive', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPipelines()

    act(() => {
      s.emit(created('pl1'))
      s.emit(created('pl1')) // dupe ignored
      s.emit(event('agent.text', { sessionId: 'x', text: 'noise' })) // unrelated
      s.emit(event('pipeline.stage.started', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }))
      s.emit(
        event('pipeline.stage.completed', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }),
      )
      s.emit(event('pipeline.stage.started', { pipelineId: 'pl1', stageIndex: 1, sessionId: 's1' }))
      s.emit(event('pipeline.failed', { pipelineId: 'pl1', stageIndex: 1, sessionId: 's1' }))
      s.emit(event('pipeline.completed', { pipelineId: 'pl1' }))
    })

    // Plan completed (done, still clickable to its agent), Implement failed,
    // Review never started (pending).
    expect(
      screen.getByRole('button', { name: 'Plan — done — select its agent' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Implement — failed — select its agent' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Review — pending')).toBeInTheDocument()
  })

  it('shows a Continue button at the gate and advances on click', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPipelines()

    // No gate while a stage runs.
    act(() => {
      s.emit(created('pl1'))
      s.emit(event('pipeline.stage.started', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }))
    })
    expect(screen.queryByRole('button', { name: /Continue/ })).not.toBeInTheDocument()

    // Stage 0 finishes → the pipeline pauses and offers Continue → Implement.
    act(() => {
      s.emit(
        event('pipeline.stage.completed', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }),
      )
    })
    const go = screen.getByRole('button', { name: 'Continue → Implement' })
    fireEvent.click(go)
    expect(s.continueStage).toHaveBeenCalledWith('pl1', 's0')

    // Once the next stage starts, the gate is gone.
    act(() => {
      s.emit(event('pipeline.stage.started', { pipelineId: 'pl1', stageIndex: 1, sessionId: 's1' }))
    })
    expect(screen.queryByRole('button', { name: /Continue/ })).not.toBeInTheDocument()
  })

  it('offers no Continue button once the pipeline has failed or completed', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPipelines()

    act(() => {
      s.emit(created('pl1'))
      s.emit(event('pipeline.stage.started', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }))
      s.emit(event('pipeline.failed', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }))
    })

    expect(screen.queryByRole('button', { name: /Continue/ })).not.toBeInTheDocument()
  })

  it('leaves other pipelines untouched when one advances', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPipelines()

    act(() => {
      s.emit(created('pl1', 'First'))
      s.emit(created('pl2', 'Second'))
      // Target only pl2 — pl1's chips and done-flag must not change.
      s.emit(event('pipeline.stage.started', { pipelineId: 'pl2', stageIndex: 0, sessionId: 's9' }))
      s.emit(event('pipeline.completed', { pipelineId: 'pl2' }))
    })

    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByLabelText('Plan — pending')).toBeInTheDocument() // pl1 stage 0 still pending
    expect(
      screen.getByRole('button', { name: 'Plan — running — select its agent' }),
    ).toBeInTheDocument() // pl2 stage 0
  })

  it('ignores lifecycle events for an unknown pipeline', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPipelines()

    act(() => {
      s.emit(created('pl1'))
      // No such pipeline — must be a no-op, not a crash.
      s.emit(
        event('pipeline.stage.started', { pipelineId: 'ghost', stageIndex: 0, sessionId: 'g' }),
      )
    })

    expect(screen.getByLabelText('Plan — pending')).toBeInTheDocument()
  })

  it('selects a launched stage’s agent on click', () => {
    const s = stub()
    window.agentinator = s.bridge
    let selection: unknown
    function Probe(): null {
      selection = useSelection().selection
      return null
    }
    render(
      <SelectionProvider>
        <PipelineProvider>
          <Probe />
          <Pipelines />
        </PipelineProvider>
      </SelectionProvider>,
    )

    act(() => {
      s.emit(created('pl1'))
      s.emit(event('pipeline.stage.started', { pipelineId: 'pl1', stageIndex: 0, sessionId: 's0' }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Plan — running — select its agent' }))

    expect(selection).toEqual({ kind: 'session', id: 's0' })
  })

  it('ignores a backfill that resolves after unmount', async () => {
    window.agentinator = stub([created('pl1')]).bridge
    const { unmount } = render(
      <SelectionProvider>
        <PipelineProvider>
          <Pipelines />
        </PipelineProvider>
      </SelectionProvider>,
    )
    unmount()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('throws if usePipelines is used outside a provider', () => {
    expect(() => renderHook(() => usePipelines())).toThrow('within a PipelineProvider')
  })
})
