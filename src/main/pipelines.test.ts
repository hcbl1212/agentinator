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
  const retireStage = vi.fn<(sessionId: string) => void>()
  const orchestrator = new PipelineOrchestrator({ emit, store, startStage, retireStage })

  return {
    orchestrator,
    log,
    emit,
    startStage,
    retireStage,
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
    // A finished turn — how a stage normally completes (the agent stays alive).
    idled: (sessionId: string): void => {
      orchestrator.observe({ seq: ++seq, ts: 't', type: 'session.idle', payload: { sessionId } })
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
    // The plan stage must not touch files — a later stage implements it.
    expect(stages[0].prompt).toContain('Do not edit')
    expect(stages[1].prompt).toContain('add a logout button')
    // Review reads the shared worktree's diff, not the raw task.
    expect(stages[2].prompt).toContain('git diff')
  })
})

describe('PipelineOrchestrator', () => {
  it('records the pipeline and dispatches its first stage', () => {
    const h = harness()

    const id = h.orchestrator.create('Add logout', defaultPipelineStages('add logout'))

    expect(id).toMatch(/^pipeline_/)
    expect(h.types()).toEqual(['pipeline.created', 'pipeline.stage.started'])
    expect(h.startStage).toHaveBeenCalledTimes(1)
    expect(h.startStage.mock.calls[0][0]).toContain('PLANNING stage')
    expect(h.log[1].payload).toMatchObject({ pipelineId: id, stageIndex: 0, sessionId: 'sess0' })
  })

  it('pauses at the boundary when a stage finishes, then continues on request', () => {
    const h = harness()
    const id = h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.seedText('sess0', 'THE PLAN')

    h.idled('sess0')

    // The stage completes and its agent is retired, but the next stage does NOT
    // auto-start — the pipeline waits for the user (the human-in-the-loop gate).
    expect(h.types()).toEqual([
      'pipeline.created',
      'pipeline.stage.started',
      'agent.text',
      'pipeline.stage.completed',
    ])
    expect(h.retireStage).toHaveBeenCalledWith('sess0')
    expect(h.startStage).toHaveBeenCalledTimes(1)

    // Continue launches the next stage with the plan handed forward.
    h.orchestrator.continueStage(id, 'sess0')
    expect(h.startStage).toHaveBeenCalledTimes(2)
    const implementPrompt = h.startStage.mock.calls[1][0]
    expect(implementPrompt).toContain('IMPLEMENTATION stage')
    expect(implementPrompt).toContain(HANDOFF_HEADER)
    expect(implementPrompt).toContain('THE PLAN')
  })

  it('completes a stage that ends with a completed outcome', () => {
    const h = harness()
    h.orchestrator.create('T', defaultPipelineStages('do it'))

    // Some providers end on completion rather than going idle — still a stage
    // completion (which then pauses at the gate).
    h.ended('sess0', 'completed')

    expect(h.types()).toContain('pipeline.stage.completed')
    expect(h.retireStage).toHaveBeenCalledWith('sess0')
    expect(h.startStage).toHaveBeenCalledTimes(1)
  })

  it('reuses the finishing stage’s worktree for the next stage', () => {
    const h = harness()
    const worktree: WorktreeInfo = {
      repoRoot: '/repo',
      path: '/wt/sess0',
      branch: 'agentinator/sess0',
    }
    const id = h.orchestrator.create('T', defaultPipelineStages('do it'))
    // Stage 0 ran in an isolated worktree (recorded on its session.started).
    h.seedStarted('sess0', worktree)

    h.idled('sess0')
    h.orchestrator.continueStage(id, 'sess0')

    // The next stage launches in the same checkout, so it sees stage 0's edits.
    expect(h.startStage.mock.calls[1][1]).toEqual(worktree)
  })

  it('passes no worktree onward for a non-isolated provider', () => {
    const h = harness()
    const id = h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.seedStarted('sess0') // started with no worktree

    h.idled('sess0')
    h.orchestrator.continueStage(id, 'sess0')

    expect(h.startStage.mock.calls[1][1]).toBeUndefined()
  })

  it('completes the pipeline after the last stage is continued', () => {
    const h = harness()
    const id = h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.seedText('sess0', 'plan')
    h.idled('sess0')
    h.orchestrator.continueStage(id, 'sess0') // → Implement (sess1)
    h.seedText('sess1', 'implemented')
    h.idled('sess1')
    h.orchestrator.continueStage(id, 'sess1') // → Review (sess2)
    h.idled('sess2') // last stage → done, no gate

    expect(h.startStage).toHaveBeenCalledTimes(3)
    expect(h.types()).toContain('pipeline.completed')
    expect(h.types().filter((type) => type === 'pipeline.stage.completed')).toHaveLength(3)
  })

  it('hands off nothing extra when a stage produced no output', () => {
    const h = harness()
    const stages = defaultPipelineStages('do it')
    const id = h.orchestrator.create('T', stages)

    h.idled('sess0') // no agent.text seeded for sess0
    h.orchestrator.continueStage(id, 'sess0')

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

  it('resolves a stage only once even if its agent reports finished twice', () => {
    const h = harness()
    h.orchestrator.create('T', defaultPipelineStages('do it'))

    h.idled('sess0')
    h.idled('sess0') // a duplicate finish must be ignored

    expect(h.types().filter((type) => type === 'pipeline.stage.completed')).toHaveLength(1)
    expect(h.retireStage).toHaveBeenCalledTimes(1)
  })

  it('does not launch the next stage twice on a double Continue', () => {
    const h = harness()
    const id = h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.idled('sess0')

    h.orchestrator.continueStage(id, 'sess0') // dispatches Implement
    h.orchestrator.continueStage(id, 'sess0') // double click — guarded

    expect(h.startStage).toHaveBeenCalledTimes(2)
  })

  it('continuing an unknown or removed pipeline is a no-op', () => {
    const h = harness()
    const id = h.orchestrator.create('T', defaultPipelineStages('do it'))
    h.idled('sess0')
    h.orchestrator.remove(id)

    h.orchestrator.continueStage(id, 'sess0')

    expect(h.startStage).toHaveBeenCalledTimes(1) // only the initial dispatch
  })

  it('continuing from a session that never ran a stage is a no-op', () => {
    const h = harness()
    const id = h.orchestrator.create('T', defaultPipelineStages('do it'))

    // 'stranger' has no pipeline.stage.started in the log.
    h.orchestrator.continueStage(id, 'stranger')

    expect(h.startStage).toHaveBeenCalledTimes(1)
  })

  it('continuing past the last stage is a no-op', () => {
    const h = harness()
    const stages = defaultPipelineStages('do it')
    const id = h.orchestrator.create('T', stages)
    // Drive to the final stage running.
    h.idled('sess0')
    h.orchestrator.continueStage(id, 'sess0') // Implement (sess1)
    h.idled('sess1')
    h.orchestrator.continueStage(id, 'sess1') // Review (sess2) — the last stage
    const before = h.startStage.mock.calls.length

    h.orchestrator.continueStage(id, 'sess2') // nothing after Review

    expect(h.startStage.mock.calls.length).toBe(before)
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

  it('rebuilds pipeline state from the log so a paused pipeline can be continued after a restart', () => {
    const first = harness()
    const id = first.orchestrator.create('T', defaultPipelineStages('do it'))
    first.seedText('sess0', 'plan')
    first.idled('sess0') // stage 0 done → paused at the gate

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
      retireStage: vi.fn(),
    })
    revived.reconcile(first.log)
    revived.continueStage(id, 'sess0')

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

  it('removes a pipeline so it stops advancing', () => {
    const h = harness()
    const id = h.orchestrator.create('T', defaultPipelineStages('do it'))

    h.orchestrator.remove(id)

    expect(
      h.log.some(
        (e) =>
          e.type === 'pipeline.removed' && (e.payload as { pipelineId: string }).pipelineId === id,
      ),
    ).toBe(true)
    // A stage that finishes after removal finds no definition → no next stage.
    h.idled('sess0')
    expect(h.startStage).toHaveBeenCalledTimes(1)
  })

  it('forgets a removed pipeline on reconcile so it never resumes advancing', () => {
    const first = harness()
    const id = first.orchestrator.create('T', defaultPipelineStages('do it'))
    first.orchestrator.remove(id) // log: created, stage.started, removed

    const startStage = vi.fn(() => 'sess-x')
    const revived = new PipelineOrchestrator({
      emit: first.emit,
      store: {
        listBySession: (sid) =>
          first.log.filter((e) => (e.payload as { sessionId?: string }).sessionId === sid),
      },
      startStage,
      retireStage: vi.fn(),
    })
    revived.reconcile(first.log) // sees created then removed → forgotten

    revived.observe({ seq: 900, ts: 't', type: 'session.idle', payload: { sessionId: 'sess0' } })

    expect(startStage).not.toHaveBeenCalled()
  })
})
