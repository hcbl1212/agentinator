import { describe, expect, it, vi } from 'vitest'

import type { EventPayloads, EventType, StoredEvent } from '../shared/events'
import type { EmitStored } from './approvals'
import { defaultPipelineStages, HANDOFF_HEADER, PipelineOrchestrator } from './pipelines'
import type { WorktreeInfo } from './worktrees'

/** A tiny in-memory log that models the real store closely enough for the
 * orchestrator: emitted events land in the log, `listBySession` serves the
 * session index (events whose payload carries that sessionId), and stage agents
 * hand back deterministic session ids. */
function harness() {
  const log: StoredEvent[] = []
  let seq = 0
  const push = <T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent<T> => {
    const event = { seq: ++seq, ts: 't', type, payload } as StoredEvent<T>
    log.push(event)
    return event
  }
  const emit = vi.fn(push) as unknown as EmitStored & { mock: { calls: unknown[] } }
  const store = {
    listBySession: (id: string): StoredEvent[] =>
      log.filter((event) => (event.payload as { sessionId?: string }).sessionId === id),
  }
  let n = 0
  const startStage = vi.fn<(prompt: string, worktree?: WorktreeInfo) => string>(() => `sess${n++}`)
  const orchestrator = new PipelineOrchestrator({ emit, store, startStage })

  return {
    orchestrator,
    log,
    emit,
    startStage,
    types: (): string[] => log.map((event) => event.type),
    seedText: (sessionId: string, text: string): void => {
      push('agent.text', { sessionId, text })
    },
    seedStarted: (sessionId: string, worktree?: WorktreeInfo): void => {
      push('session.started', {
        sessionId,
        agentId: 'a',
        workspaceId: 'w',
        title: 't',
        ...(worktree === undefined ? {} : { worktree }),
      })
    },
    ended: (sessionId: string, outcome: 'completed' | 'cancelled' | 'failed'): void => {
      orchestrator.observe({
        seq: ++seq,
        ts: 't',
        type: 'session.ended',
        payload: { sessionId, outcome },
      })
    },
  }
}

describe('defaultPipelineStages', () => {
  it('is a Plan → Implement → Review chain carrying the task', () => {
    const stages = defaultPipelineStages('add a logout button')

    expect(stages.map((stage) => stage.name)).toEqual(['Plan', 'Implement', 'Review'])
    expect(stages[0].prompt).toContain('add a logout button')
    expect(stages[1].prompt).toContain('add a logout button')
    // Review works off the handoff, not the raw task, so it needn't echo it.
    expect(stages[2].prompt).toContain('Review the implementation')
  })
})

describe('PipelineOrchestrator', () => {
  it('records the pipeline and dispatches its first stage', () => {
    const h = harness()

    const id = h.orchestrator.create('Add logout', defaultPipelineStages('add logout'))

    expect(id).toMatch(/^pipeline_/)
    expect(h.types()).toEqual(['pipeline.created', 'pipeline.stage.started'])
    expect(h.startStage).toHaveBeenCalledTimes(1)
    expect(h.startStage.mock.calls[0][0]).toContain('Plan the following task')
    expect(h.log[1].payload).toMatchObject({ pipelineId: id, stageIndex: 0, sessionId: 'sess0' })
  })

  it('advances to the next stage with the prior output as handoff', () => {
    const h = harness()
    h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.seedText('sess0', 'THE PLAN')

    h.ended('sess0', 'completed')

    expect(h.types()).toEqual([
      'pipeline.created',
      'pipeline.stage.started',
      'agent.text',
      'pipeline.stage.completed',
      'pipeline.stage.started',
    ])
    expect(h.startStage).toHaveBeenCalledTimes(2)
    const implementPrompt = h.startStage.mock.calls[1][0]
    expect(implementPrompt).toContain('Implement the following task')
    expect(implementPrompt).toContain(HANDOFF_HEADER)
    expect(implementPrompt).toContain('THE PLAN')
  })

  it('reuses the finishing stage’s worktree for the next stage', () => {
    const h = harness()
    const worktree: WorktreeInfo = {
      repoRoot: '/repo',
      path: '/wt/sess0',
      branch: 'agentinator/sess0',
    }
    h.orchestrator.create('T', defaultPipelineStages('do it'))
    // Stage 0 ran in an isolated worktree (recorded on its session.started).
    h.seedStarted('sess0', worktree)

    h.ended('sess0', 'completed')

    // The next stage launches in the same checkout, so it sees stage 0's edits.
    expect(h.startStage.mock.calls[1][1]).toEqual(worktree)
  })

  it('passes no worktree onward for a non-isolated provider', () => {
    const h = harness()
    h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.seedStarted('sess0') // started with no worktree

    h.ended('sess0', 'completed')

    expect(h.startStage.mock.calls[1][1]).toBeUndefined()
  })

  it('completes the pipeline after the last stage', () => {
    const h = harness()
    h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.seedText('sess0', 'plan')
    h.ended('sess0', 'completed') // → Implement (sess1)
    h.seedText('sess1', 'implemented')
    h.ended('sess1', 'completed') // → Review (sess2)
    h.ended('sess2', 'completed') // last stage → done

    expect(h.startStage).toHaveBeenCalledTimes(3)
    expect(h.types()).toContain('pipeline.completed')
    expect(h.types().filter((type) => type === 'pipeline.stage.completed')).toHaveLength(3)
  })

  it('hands off nothing extra when a stage produced no output', () => {
    const h = harness()
    const stages = defaultPipelineStages('do it')
    h.orchestrator.create('T', stages)

    h.ended('sess0', 'completed') // no agent.text seeded for sess0

    const implementPrompt = h.startStage.mock.calls[1][0]
    expect(implementPrompt).toBe(stages[1].prompt)
    expect(implementPrompt).not.toContain(HANDOFF_HEADER)
  })

  it('halts the pipeline when a stage fails or is cancelled', () => {
    const h = harness()
    h.orchestrator.create('T', defaultPipelineStages('do it'))

    h.ended('sess0', 'failed')

    expect(h.startStage).toHaveBeenCalledTimes(1) // no next stage dispatched
    const failed = h.log.find((event) => event.type === 'pipeline.failed')
    expect(failed?.payload).toMatchObject({ stageIndex: 0, sessionId: 'sess0' })
  })

  it('ignores events that are not a session ending', () => {
    const h = harness()
    h.orchestrator.create('T', defaultPipelineStages('do it'))
    const before = h.log.length

    h.orchestrator.observe({
      seq: 99,
      ts: 't',
      type: 'agent.text',
      payload: { sessionId: 'sess0', text: 'x' },
    })

    expect(h.log.length).toBe(before)
  })

  it('ignores a session that is not a pipeline stage', () => {
    const h = harness()
    const before = h.log.length

    h.ended('unrelated', 'completed')

    expect(h.log.length).toBe(before)
    expect(h.startStage).not.toHaveBeenCalled()
  })

  it('does not advance a stage twice', () => {
    const h = harness()
    h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.ended('sess0', 'completed') // advances to sess1

    h.ended('sess0', 'completed') // a duplicate end must be ignored

    expect(h.startStage).toHaveBeenCalledTimes(2)
  })

  it('ignores a stage whose pipeline definition is unknown', () => {
    const h = harness()
    // A stray stage.started with no matching pipeline.created in memory.
    h.emit('pipeline.stage.started', {
      pipelineId: 'pipeline_ghost',
      stageIndex: 0,
      sessionId: 'ghost',
    })
    const before = h.log.length

    h.ended('ghost', 'completed')

    expect(h.log.length).toBe(before)
  })

  it('rebuilds pipeline state from the log so it advances across a restart', () => {
    const first = harness()
    const id = first.orchestrator.create('T', defaultPipelineStages('do it'))
    first.seedText('sess0', 'plan')

    // A "restart": a fresh orchestrator over the same log, with no in-memory
    // state until it reconciles.
    const startStage = vi.fn(() => 'sess-resumed')
    const revived = new PipelineOrchestrator({
      emit: first.emit,
      store: {
        listBySession: (sid) =>
          first.log.filter((e) => (e.payload as { sessionId?: string }).sessionId === sid),
      },
      startStage,
    })
    revived.reconcile(first.log)
    revived.observe({
      seq: 500,
      ts: 't',
      type: 'session.ended',
      payload: { sessionId: 'sess0', outcome: 'completed' },
    })

    expect(startStage).toHaveBeenCalledTimes(1)
    const started = first.log.find(
      (event) =>
        event.type === 'pipeline.stage.started' &&
        (event.payload as { stageIndex: number }).stageIndex === 1,
    )
    expect(started?.payload).toMatchObject({
      pipelineId: id,
      stageIndex: 1,
      sessionId: 'sess-resumed',
    })
  })
})
