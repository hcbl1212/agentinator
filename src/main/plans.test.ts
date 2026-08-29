import { describe, expect, it, vi } from 'vitest'

import type { EventPayloads, EventType, StoredEvent } from '../shared/events'
import type { EmitStored } from './approvals'
import { PLAN_CONTEXT_HEADER, PlanOrchestrator } from './plans'

/** A tiny in-memory log that models the real store closely enough for the
 * orchestrator: emitted events land in the log, `listBySession` serves the
 * session index (events whose payload carries that sessionId), and dispatched
 * task agents hand back deterministic session ids. */
function harness() {
  const log: StoredEvent[] = []
  let seq = 0
  const push = <T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent<T> => {
    const event = { seq: ++seq, ts: 't', type, payload } as StoredEvent<T>
    log.push(event)
    return event
  }
  const emit = vi.fn(push) as unknown as EmitStored & { mock: { calls: unknown[][] } }
  const store = {
    listBySession: (id: string): StoredEvent[] =>
      log.filter((event) => (event.payload as { sessionId?: string }).sessionId === id),
  }
  let n = 0
  const startTask = vi.fn<(prompt: string, agentTypeId?: string) => string>(() => `sess${n++}`)
  let p = 0
  const startPipeline = vi.fn<(prompt: string) => string>(() => `pipe${p++}`)
  const orchestrator = new PlanOrchestrator({ emit, store, startTask, startPipeline })

  return {
    orchestrator,
    log,
    emit,
    startTask,
    startPipeline,
    types: (): string[] => log.map((event) => event.type),
    // A finished turn — how a task normally completes (the agent stays alive).
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
    // A pipeline resolving — how a pipelined task completes or fails.
    pipelineDone: (pipelineId: string): void => {
      orchestrator.observe({
        seq: ++seq,
        ts: 't',
        type: 'pipeline.completed',
        payload: { pipelineId },
      })
    },
    pipelineFailed: (pipelineId: string): void => {
      orchestrator.observe({
        seq: ++seq,
        ts: 't',
        type: 'pipeline.failed',
        payload: { pipelineId, stageIndex: 1, sessionId: 'stage_sess' },
      })
    },
    createChain: (): { planId: string; tasks: EventPayloads['plan.created']['tasks'] } => {
      const planId = orchestrator.create('Chain', 'build the thing', [
        { title: 'A', prompt: 'do a', dependsOn: [] },
        { title: 'B', prompt: 'do b', dependsOn: [0] },
        { title: 'C', prompt: 'do c', dependsOn: [0, 1] },
      ])
      const created = log.find((event) => event.type === 'plan.created')
        ?.payload as EventPayloads['plan.created']
      return { planId, tasks: created.tasks }
    },
  }
}

describe('PlanOrchestrator', () => {
  it('creates a plan with minted task ids and index deps mapped onto them', () => {
    const h = harness()

    const { planId, tasks } = h.createChain()

    expect(planId).toMatch(/^plan_/)
    expect(tasks.map((task) => task.title)).toEqual(['A', 'B', 'C'])
    for (const task of tasks) {
      expect(task.taskId).toMatch(/^task_/)
    }
    expect(tasks[0].dependsOn).toEqual([])
    expect(tasks[1].dependsOn).toEqual([tasks[0].taskId])
    expect(tasks[2].dependsOn).toEqual([tasks[0].taskId, tasks[1].taskId])
    // Creating dispatches nothing — the user fires the frontier.
    expect(h.startTask).not.toHaveBeenCalled()
  })

  it('dispatches a ready task with the requirement as context and links its session', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    const sessionId = h.orchestrator.dispatch(planId, tasks[0].taskId)

    expect(sessionId).toBe('sess0')
    const prompt = h.startTask.mock.calls[0][0]
    expect(prompt).toContain('do a')
    expect(prompt).toContain(PLAN_CONTEXT_HEADER)
    expect(prompt).toContain('build the thing')
    expect(h.emit).toHaveBeenCalledWith('plan.task.dispatched', {
      planId,
      taskId: tasks[0].taskId,
      sessionId: 'sess0',
    })
  })

  it('refuses a blocked task, an unknown plan or task, and a double dispatch', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    // B waits on A — not ready yet.
    expect(h.orchestrator.dispatch(planId, tasks[1].taskId)).toBeNull()
    expect(h.orchestrator.dispatch('plan_ghost', tasks[0].taskId)).toBeNull()
    expect(h.orchestrator.dispatch(planId, 'task_ghost')).toBeNull()

    expect(h.orchestrator.dispatch(planId, tasks[0].taskId)).toBe('sess0')
    // Already in flight — a second click can't launch a twin agent.
    expect(h.orchestrator.dispatch(planId, tasks[0].taskId)).toBeNull()
    expect(h.startTask).toHaveBeenCalledOnce()
  })

  it('completes a task when its agent idles, unlocking its dependents', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()
    h.orchestrator.dispatch(planId, tasks[0].taskId)

    h.idled('sess0')

    expect(h.emit).toHaveBeenCalledWith('plan.task.completed', {
      planId,
      taskId: tasks[0].taskId,
      sessionId: 'sess0',
    })
    // A is done → B joins the frontier; C still waits on B.
    expect(h.orchestrator.dispatch(planId, tasks[2].taskId)).toBeNull()
    expect(h.orchestrator.dispatch(planId, tasks[1].taskId)).toBe('sess1')
  })

  it('resolves a task once, even when idle is followed by ended', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()
    h.orchestrator.dispatch(planId, tasks[0].taskId)

    h.idled('sess0')
    h.ended('sess0', 'completed')

    expect(h.types().filter((type) => type === 'plan.task.completed')).toHaveLength(1)
  })

  it('marks a cancelled agent failed and reopens the task for a retry', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()
    h.orchestrator.dispatch(planId, tasks[0].taskId)

    h.ended('sess0', 'cancelled')

    expect(h.emit).toHaveBeenCalledWith('plan.task.failed', {
      planId,
      taskId: tasks[0].taskId,
      sessionId: 'sess0',
    })
    // Failure isn't a dead end — the task dispatches again with a fresh agent.
    expect(h.orchestrator.dispatch(planId, tasks[0].taskId)).toBe('sess1')
  })

  it('ignores sessions that are not plan tasks and unrelated event types', () => {
    const h = harness()
    h.createChain()

    h.idled('sess_unrelated')
    h.orchestrator.observe({
      seq: 99,
      ts: 't',
      type: 'agent.text',
      payload: { sessionId: 'x', text: 'noise' },
    })

    expect(h.types()).toEqual(['plan.created'])
  })

  it('removes a plan: it stops dispatching and its stray agents resolve nothing', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()
    h.orchestrator.dispatch(planId, tasks[0].taskId)

    h.orchestrator.remove(planId)

    expect(h.emit).toHaveBeenCalledWith('plan.removed', { planId })
    // The in-flight agent finishing finds no plan — no completion is recorded.
    h.idled('sess0')
    expect(h.types()).not.toContain('plan.task.completed')
    expect(h.orchestrator.dispatch(planId, tasks[1].taskId)).toBeNull()
  })

  it('carries a suggested agent type into the plan and hands it to dispatch', () => {
    const h = harness()
    const planId = h.orchestrator.create('Typed', 'review the diff', [
      { title: 'Check', prompt: 'check it', dependsOn: [], agentTypeId: 'at_rev' },
    ])
    const created = h.log.find((event) => event.type === 'plan.created')
      ?.payload as EventPayloads['plan.created']

    expect(created.tasks[0].agentTypeId).toBe('at_rev')
    h.orchestrator.dispatch(planId, created.tasks[0].taskId)
    expect(h.startTask).toHaveBeenCalledWith(expect.stringContaining('check it'), 'at_rev')
  })

  it('retypes an undispatched task, and the new role rides the dispatch', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.retype(planId, tasks[0].taskId, 'at_doc')).toBe(true)
    expect(h.emit).toHaveBeenCalledWith('plan.task.retyped', {
      planId,
      taskId: tasks[0].taskId,
      agentTypeId: 'at_doc',
    })
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    expect(h.startTask).toHaveBeenCalledWith(expect.any(String), 'at_doc')
  })

  it('retypes back to the default agent with null', () => {
    const h = harness()
    const planId = h.orchestrator.create('Typed', 'r', [
      { title: 'X', prompt: 'x', dependsOn: [], agentTypeId: 'at_rev' },
    ])
    const taskId = (
      h.log.find((event) => event.type === 'plan.created')?.payload as EventPayloads['plan.created']
    ).tasks[0].taskId

    expect(h.orchestrator.retype(planId, taskId, null)).toBe(true)
    h.orchestrator.dispatch(planId, taskId)
    expect(h.startTask).toHaveBeenCalledWith(expect.any(String), undefined)
  })

  it('refuses retyping an unknown task or one whose agent already launched', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.retype('plan_ghost', tasks[0].taskId, 'at_rev')).toBe(false)
    expect(h.orchestrator.retype(planId, 'task_ghost', 'at_rev')).toBe(false)
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    expect(h.orchestrator.retype(planId, tasks[0].taskId, 'at_rev')).toBe(false)
    expect(h.types()).not.toContain('plan.task.retyped')
  })

  it('reconciles retyped tasks across a restart (including clearing to default)', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    first.orchestrator.retype(planId, tasks[0].taskId, 'at_rev')
    first.orchestrator.retype(planId, tasks[1].taskId, 'at_doc')
    first.orchestrator.retype(planId, tasks[1].taskId, null)
    // A retype event for a forgotten plan replays as a no-op.
    const stray: StoredEvent = {
      seq: 99,
      ts: 't',
      type: 'plan.task.retyped',
      payload: { planId: 'plan_ghost', taskId: 'task_x', agentTypeId: 'at_rev' },
    }

    const second = harness()
    second.orchestrator.reconcile([...first.log, stray])

    second.orchestrator.dispatch(planId, tasks[0].taskId)
    expect(second.startTask).toHaveBeenCalledWith(expect.any(String), 'at_rev')
  })

  it('dispatches a ready task as a pipeline carrying the same brief', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    const pipelineId = h.orchestrator.dispatchPipeline(planId, tasks[0].taskId)

    expect(pipelineId).toBe('pipe0')
    const prompt = h.startPipeline.mock.calls[0][0]
    expect(prompt).toContain('do a')
    expect(prompt).toContain(PLAN_CONTEXT_HEADER)
    expect(prompt).toContain('build the thing')
    expect(h.emit).toHaveBeenCalledWith('plan.task.pipelined', {
      planId,
      taskId: tasks[0].taskId,
      pipelineId: 'pipe0',
    })
    // Either dispatch mode counts as launched — no twin runs.
    expect(h.orchestrator.dispatch(planId, tasks[0].taskId)).toBeNull()
    expect(h.orchestrator.dispatchPipeline(planId, tasks[0].taskId)).toBeNull()
    // And the guards mirror dispatch: blocked and unknown refuse.
    expect(h.orchestrator.dispatchPipeline(planId, tasks[1].taskId)).toBeNull()
    expect(h.orchestrator.dispatchPipeline('plan_ghost', tasks[0].taskId)).toBeNull()
    expect(h.orchestrator.dispatchPipeline(planId, 'task_ghost')).toBeNull()
    expect(h.startPipeline).toHaveBeenCalledOnce()
  })

  it('completes a pipelined task when its pipeline completes, unlocking dependents', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()
    h.orchestrator.dispatchPipeline(planId, tasks[0].taskId)

    h.pipelineDone('pipe0')

    expect(h.emit).toHaveBeenCalledWith('plan.task.completed', {
      planId,
      taskId: tasks[0].taskId,
    })
    expect(h.orchestrator.dispatch(planId, tasks[1].taskId)).toBe('sess0')
    // The link is spent: a stray second completion changes nothing.
    h.pipelineDone('pipe0')
    expect(h.types().filter((type) => type === 'plan.task.completed')).toHaveLength(1)
  })

  it('fails a pipelined task when its pipeline fails, reopening it for a retry', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()
    h.orchestrator.dispatchPipeline(planId, tasks[0].taskId)

    h.pipelineFailed('pipe0')

    expect(h.emit).toHaveBeenCalledWith('plan.task.failed', {
      planId,
      taskId: tasks[0].taskId,
    })
    // The retry may pick either mode; a later revive of the DEAD pipeline
    // (its link was dropped at failure) resolves nothing.
    expect(h.orchestrator.dispatch(planId, tasks[0].taskId)).toBe('sess0')
    h.pipelineDone('pipe0')
    expect(h.types()).not.toContain('plan.task.completed')
  })

  it('ignores pipelines that are not plan tasks, and stray ones from removed plans', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    // A composer-launched pipeline — no plan task attached.
    h.pipelineDone('pipe_foreign')
    expect(h.types()).toEqual(['plan.created'])

    h.orchestrator.dispatchPipeline(planId, tasks[0].taskId)
    h.orchestrator.remove(planId)
    h.pipelineDone('pipe0')
    expect(h.types()).not.toContain('plan.task.completed')
  })

  it('reconciles a pipelined task across a restart: guarded, then resolved late', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    first.orchestrator.dispatchPipeline(planId, tasks[0].taskId)

    // Restart mid-pipeline: the task is still in flight (no double launch),
    // and the surviving link resolves it when the pipeline finally completes.
    const second = harness()
    second.orchestrator.reconcile(first.log)
    expect(second.orchestrator.dispatchPipeline(planId, tasks[0].taskId)).toBeNull()
    second.pipelineDone('pipe0')
    expect(second.types()).toContain('plan.task.completed')

    // A restart AFTER resolution forgets the link — the stray completion of a
    // spent pipeline changes nothing more.
    const third = harness()
    third.orchestrator.reconcile([...first.log, ...second.log])
    third.pipelineDone('pipe0')
    expect(third.types()).not.toContain('plan.task.completed')
  })

  it('reconciles a failed pipelined task as reopened, its link dropped, siblings kept', () => {
    const first = harness()
    const planId = first.orchestrator.create('Wide', 'two independent tasks', [
      { title: 'X', prompt: 'x', dependsOn: [] },
      { title: 'Y', prompt: 'y', dependsOn: [] },
    ])
    const tasks = (
      first.log.find((event) => event.type === 'plan.created')
        ?.payload as EventPayloads['plan.created']
    ).tasks
    first.orchestrator.dispatchPipeline(planId, tasks[0].taskId) // pipe0
    first.orchestrator.dispatchPipeline(planId, tasks[1].taskId) // pipe1
    first.pipelineFailed('pipe0')

    const second = harness()
    second.orchestrator.reconcile(first.log)

    // X's dead pipeline resolves nothing and X is dispatchable again…
    second.pipelineDone('pipe0')
    expect(second.types()).not.toContain('plan.task.completed')
    expect(second.orchestrator.dispatchPipeline(planId, tasks[0].taskId)).toBe('pipe0')
    // …while Y's surviving link still resolves it.
    second.pipelineDone('pipe1')
    expect(second.types()).toContain('plan.task.completed')
  })

  it('expands a task in place: roots inherit its deps, dependents wait on the leaves', () => {
    const h = harness()
    const { planId, tasks } = h.createChain() // A ← B ← C (C also waits on A)

    // B becomes X → Y (Y waits on X). X stands where B stood (inherits A);
    // C's wait on B becomes a wait on Y, the sub-graph's leaf.
    expect(
      h.orchestrator.expand(planId, tasks[1].taskId, [
        { title: 'X', prompt: 'do x', dependsOn: [] },
        { title: 'Y', prompt: 'do y', dependsOn: [0] },
      ]),
    ).toBe(true)
    const expanded = h.log.find((event) => event.type === 'plan.task.expanded')
      ?.payload as EventPayloads['plan.task.expanded']
    expect(expanded.tasks.map((task) => task.title)).toEqual(['X', 'Y'])
    expect(expanded.tasks[0].dependsOn).toEqual([tasks[0].taskId]) // root inherits A
    expect(expanded.tasks[1].dependsOn).toEqual([expanded.tasks[0].taskId])

    // The graph behaves as spliced: finish A → X is ready, C still is not.
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    h.idled('sess0')
    expect(h.orchestrator.dispatch(planId, tasks[2].taskId)).toBeNull()
    expect(h.orchestrator.dispatch(planId, expanded.tasks[0].taskId)).toBe('sess1')
    h.idled('sess1')
    expect(h.orchestrator.dispatch(planId, expanded.tasks[1].taskId)).toBe('sess2')
    h.idled('sess2')
    // Every sub-task done → C's rewired frontier finally opens.
    expect(h.orchestrator.dispatch(planId, tasks[2].taskId)).toBe('sess3')
  })

  it('expansion sub-tasks inherit the parent role unless they name their own', () => {
    const h = harness()
    const planId = h.orchestrator.create('Typed', 'r', [
      { title: 'T', prompt: 't', dependsOn: [], agentTypeId: 'at_parent' },
    ])
    const parent = (
      h.log.find((event) => event.type === 'plan.created')?.payload as EventPayloads['plan.created']
    ).tasks[0]

    h.orchestrator.expand(planId, parent.taskId, [
      { title: 'Inherits', prompt: 'a', dependsOn: [] },
      { title: 'Own', prompt: 'b', dependsOn: [], agentTypeId: 'at_own' },
    ])

    const expanded = h.log.find((event) => event.type === 'plan.task.expanded')
      ?.payload as EventPayloads['plan.task.expanded']
    expect(expanded.tasks[0].agentTypeId).toBe('at_parent')
    expect(expanded.tasks[1].agentTypeId).toBe('at_own')
  })

  it('two parallel sub-leaves BOTH gate the parent’s dependents', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    h.orchestrator.expand(planId, tasks[1].taskId, [
      { title: 'P', prompt: 'p', dependsOn: [] },
      { title: 'Q', prompt: 'q', dependsOn: [] },
    ])
    const expanded = h.log.find((event) => event.type === 'plan.task.expanded')
      ?.payload as EventPayloads['plan.task.expanded']
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    h.idled('sess0')
    h.orchestrator.dispatch(planId, expanded.tasks[0].taskId)
    h.idled('sess1')

    // P done, Q untouched — C must still wait.
    expect(h.orchestrator.dispatch(planId, tasks[2].taskId)).toBeNull()
  })

  it('refuses expanding unknown, launched, or emptily-decomposed tasks', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()
    const sub = [{ title: 'X', prompt: 'x', dependsOn: [] }]

    expect(h.orchestrator.expand('plan_ghost', tasks[0].taskId, sub)).toBe(false)
    expect(h.orchestrator.expand(planId, 'task_ghost', sub)).toBe(false)
    expect(h.orchestrator.expand(planId, tasks[0].taskId, [])).toBe(false)
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    expect(h.orchestrator.expand(planId, tasks[0].taskId, sub)).toBe(false)
    expect(h.types()).not.toContain('plan.task.expanded')
  })

  it('serves a brief for the decomposer only while the task is unlaunched', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.taskBrief(planId, tasks[0].taskId)).toBe('do a')
    expect(h.orchestrator.taskBrief(planId, 'task_ghost')).toBeNull()
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    expect(h.orchestrator.taskBrief(planId, tasks[0].taskId)).toBeNull()
  })

  it('reconciles an expansion (and shrugs off one aimed at a ghost)', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    first.orchestrator.expand(planId, tasks[1].taskId, [{ title: 'X', prompt: 'x', dependsOn: [] }])
    const expanded = first.log.find((event) => event.type === 'plan.task.expanded')
      ?.payload as EventPayloads['plan.task.expanded']
    const stray: StoredEvent = {
      seq: 99,
      ts: 't',
      type: 'plan.task.expanded',
      payload: { planId, taskId: 'task_ghost', tasks: [] },
    }
    const strayPlan: StoredEvent = {
      seq: 100,
      ts: 't',
      type: 'plan.task.expanded',
      payload: { planId: 'plan_ghost', taskId: 'task_x', tasks: [] },
    }

    const second = harness()
    second.orchestrator.reconcile([...first.log, stray, strayPlan])

    // The spliced graph survived the restart: B is gone, X stands in for it.
    expect(second.orchestrator.dispatch(planId, tasks[1].taskId)).toBeNull()
    second.orchestrator.dispatch(planId, tasks[0].taskId)
    second.idled('sess0')
    expect(second.orchestrator.dispatch(planId, expanded.tasks[0].taskId)).toBe('sess1')
  })

  it('reprompts an undispatched task, and the edited brief rides the dispatch', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.reprompt(planId, tasks[0].taskId, '  do a, with zustand  ')).toBe(true)
    expect(h.emit).toHaveBeenCalledWith('plan.task.reprompted', {
      planId,
      taskId: tasks[0].taskId,
      prompt: 'do a, with zustand',
    })

    h.orchestrator.dispatch(planId, tasks[0].taskId)
    const prompt = h.startTask.mock.calls[0][0]
    expect(prompt).toContain('do a, with zustand')
    expect(prompt).toContain(PLAN_CONTEXT_HEADER)
  })

  it('refuses reprompts on unknown tasks, blank briefs, and launched agents', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.reprompt('plan_ghost', tasks[0].taskId, 'x')).toBe(false)
    expect(h.orchestrator.reprompt(planId, 'task_ghost', 'x')).toBe(false)
    expect(h.orchestrator.reprompt(planId, tasks[0].taskId, '   ')).toBe(false)
    // Once dispatched, the brief is history — the agent already has it.
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    expect(h.orchestrator.reprompt(planId, tasks[0].taskId, 'too late')).toBe(false)
    expect(h.types()).not.toContain('plan.task.reprompted')
  })

  it('reconciles an edited brief across a restart (and ignores one for a ghost task)', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    first.orchestrator.reprompt(planId, tasks[0].taskId, 'do a, remembering the migration')
    // A reprompt event for a forgotten plan replays as a no-op.
    const stray: StoredEvent = {
      seq: 99,
      ts: 't',
      type: 'plan.task.reprompted',
      payload: { planId: 'plan_ghost', taskId: 'task_x', prompt: 'nope' },
    }

    const second = harness()
    second.orchestrator.reconcile([...first.log, stray])
    second.orchestrator.dispatch(planId, tasks[0].taskId)

    expect(second.startTask.mock.calls[0][0]).toContain('do a, remembering the migration')
  })

  it('adds a dependency edge that the dispatch guard then honours', () => {
    const h = harness()
    const planId = h.orchestrator.create('Wide', 'two independent tasks', [
      { title: 'X', prompt: 'x', dependsOn: [] },
      { title: 'Y', prompt: 'y', dependsOn: [] },
    ])
    const tasks = (
      h.log.find((event) => event.type === 'plan.created')?.payload as EventPayloads['plan.created']
    ).tasks

    expect(h.orchestrator.addEdge(planId, tasks[1].taskId, tasks[0].taskId)).toBe(true)
    expect(h.emit).toHaveBeenCalledWith('plan.edge.added', {
      planId,
      taskId: tasks[1].taskId,
      dependsOnTaskId: tasks[0].taskId,
    })
    // Y now waits on X — no longer dispatchable until X completes.
    expect(h.orchestrator.dispatch(planId, tasks[1].taskId)).toBeNull()
  })

  it('refuses edges that are unknown, self-loops, duplicates, cycles, or too late', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.addEdge('plan_ghost', tasks[1].taskId, tasks[0].taskId)).toBe(false)
    expect(h.orchestrator.addEdge(planId, 'task_ghost', tasks[0].taskId)).toBe(false)
    expect(h.orchestrator.addEdge(planId, tasks[1].taskId, 'task_ghost')).toBe(false)
    expect(h.orchestrator.addEdge(planId, tasks[0].taskId, tasks[0].taskId)).toBe(false)
    // B already waits on A.
    expect(h.orchestrator.addEdge(planId, tasks[1].taskId, tasks[0].taskId)).toBe(false)
    // C waits on B (transitively on A) — A waiting on C would close a cycle.
    expect(h.orchestrator.addEdge(planId, tasks[0].taskId, tasks[2].taskId)).toBe(false)
    // A dispatched task's graph is history — its edges can't change.
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    expect(h.orchestrator.addEdge(planId, tasks[0].taskId, tasks[1].taskId)).toBe(false)
    expect(h.types()).not.toContain('plan.edge.added')
  })

  it('removes an edge, putting the freed task on the frontier', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    // B waits on A; erase that edge and B is immediately dispatchable.
    expect(h.orchestrator.removeEdge(planId, tasks[1].taskId, tasks[0].taskId)).toBe(true)
    expect(h.emit).toHaveBeenCalledWith('plan.edge.removed', {
      planId,
      taskId: tasks[1].taskId,
      dependsOnTaskId: tasks[0].taskId,
    })
    expect(h.orchestrator.dispatch(planId, tasks[1].taskId)).toBe('sess0')
  })

  it('refuses removing an edge that does not exist or gates a dispatched task', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.removeEdge('plan_ghost', tasks[1].taskId, tasks[0].taskId)).toBe(false)
    expect(h.orchestrator.removeEdge(planId, tasks[1].taskId, tasks[2].taskId)).toBe(false)
    h.orchestrator.dispatch(planId, tasks[0].taskId)
    h.idled('sess0')
    h.orchestrator.dispatch(planId, tasks[1].taskId)
    expect(h.orchestrator.removeEdge(planId, tasks[1].taskId, tasks[0].taskId)).toBe(false)
    expect(h.types()).not.toContain('plan.edge.removed')
  })

  it('does not let an edge edit mutate the logged plan.created payload', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    h.orchestrator.removeEdge(planId, tasks[1].taskId, tasks[0].taskId)

    // The logged graph is history — the edit lives in orchestrator state (and
    // its own edge event), not retroactively in the created payload.
    const created = h.log.find((event) => event.type === 'plan.created')
      ?.payload as EventPayloads['plan.created']
    expect(created.tasks[1].dependsOn).toEqual([created.tasks[0].taskId])
  })

  it('reconciles edited edges across a restart', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    // Free B from A, and chain A onto B instead (A waits on B now).
    first.orchestrator.removeEdge(planId, tasks[1].taskId, tasks[0].taskId)
    first.orchestrator.addEdge(planId, tasks[0].taskId, tasks[1].taskId)

    const second = harness()
    second.orchestrator.reconcile(first.log)

    // The edited graph survived: B is free, A now waits on B.
    expect(second.orchestrator.dispatch(planId, tasks[0].taskId)).toBeNull()
    expect(second.orchestrator.dispatch(planId, tasks[1].taskId)).toBe('sess0')
  })

  it('reconciles edge events for a forgotten plan as no-ops', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    first.orchestrator.remove(planId)
    // Hand-build edge events that replay AFTER the removal — the plan is
    // forgotten, so they must fall through without crashing.
    const log: StoredEvent[] = [
      ...first.log,
      {
        seq: 98,
        ts: 't',
        type: 'plan.edge.added',
        payload: { planId, taskId: tasks[1].taskId, dependsOnTaskId: tasks[0].taskId },
      },
      {
        seq: 99,
        ts: 't',
        type: 'plan.edge.removed',
        payload: { planId, taskId: tasks[1].taskId, dependsOnTaskId: tasks[0].taskId },
      },
    ]

    const second = harness()
    second.orchestrator.reconcile(log)

    expect(second.orchestrator.dispatch(planId, tasks[0].taskId)).toBeNull()
  })

  it('walks safely past a dependency the plan does not carry (hand-built log)', () => {
    const h = harness()
    h.orchestrator.reconcile([
      {
        seq: 1,
        ts: 't',
        type: 'plan.created',
        payload: {
          planId: 'plan_g',
          title: 'G',
          requirement: 'r',
          tasks: [
            { taskId: 'task_x', title: 'X', prompt: 'x', dependsOn: [] },
            { taskId: 'task_y', title: 'Y', prompt: 'y', dependsOn: ['task_ghost'] },
          ],
        },
      },
    ])

    // The cycle walk crosses the ghost dependency without exploding, so the
    // (acyclic) edge still lands.
    expect(h.orchestrator.addEdge('plan_g', 'task_x', 'task_y')).toBe(true)
  })

  it('reconciles a plan from the log across a restart, keeping its guards', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    first.orchestrator.dispatch(planId, tasks[0].taskId)
    first.idled('sess0')
    first.orchestrator.dispatch(planId, tasks[1].taskId)

    // A fresh orchestrator (a restart) rebuilt from the same log.
    const second = harness()
    second.orchestrator.reconcile(first.log)

    // B is in flight → still guarded; A is done → C stays blocked on B.
    expect(second.orchestrator.dispatch(planId, tasks[1].taskId)).toBeNull()
    expect(second.orchestrator.dispatch(planId, tasks[2].taskId)).toBeNull()
    // A completed → a retry of A is refused too (it's done, not failed).
    expect(second.orchestrator.dispatch(planId, tasks[0].taskId)).toBeNull()
  })

  it('reconciles a failed task as reopened and a removed plan as forgotten', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    first.orchestrator.dispatch(planId, tasks[0].taskId)
    first.ended('sess0', 'failed')
    const removedPlan = first.orchestrator.create('Gone', 'obsolete', [
      { title: 'X', prompt: 'x', dependsOn: [] },
    ])
    first.orchestrator.remove(removedPlan)

    const second = harness()
    second.orchestrator.reconcile(first.log)

    // The failed task reopened → dispatchable again.
    expect(second.orchestrator.dispatch(planId, tasks[0].taskId)).toBe('sess0')
    // The removed plan stayed forgotten.
    const removedTask = (
      first.log.find(
        (event) =>
          event.type === 'plan.created' &&
          (event.payload as EventPayloads['plan.created']).planId === removedPlan,
      )?.payload as EventPayloads['plan.created']
    ).tasks[0].taskId
    expect(second.orchestrator.dispatch(removedPlan, removedTask)).toBeNull()
  })
})
