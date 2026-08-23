import { describe, expect, it, vi } from 'vitest'

import type { EventPayloads, EventType, StoredEvent } from '../shared/events'
import type { EmitStored } from './approvals'
import {
  PLAN_CONTEXT_HEADER,
  PLAN_NOTES_HEADER,
  PLAN_STEER_HEADER,
  PlanOrchestrator,
} from './plans'

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
  const steer = vi.fn<(sessionId: string, text: string) => void>()
  const orchestrator = new PlanOrchestrator({ emit, store, startTask, steer })

  return {
    orchestrator,
    log,
    emit,
    startTask,
    steer,
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

  it('rides accumulated notes on the dispatch prompt, after the task brief', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.note(planId, tasks[0].taskId, '  use zustand, not redux  ')).toBe(true)
    expect(h.orchestrator.note(planId, tasks[0].taskId, 'keep it under 200 lines')).toBe(true)
    expect(h.emit).toHaveBeenCalledWith('plan.task.noted', {
      planId,
      taskId: tasks[0].taskId,
      note: 'use zustand, not redux',
    })
    // Nothing dispatched yet — nothing to steer into.
    expect(h.steer).not.toHaveBeenCalled()

    h.orchestrator.dispatch(planId, tasks[0].taskId)
    const prompt = h.startTask.mock.calls[0][0]
    expect(prompt).toContain(
      `${PLAN_NOTES_HEADER}\nuse zustand, not redux\nkeep it under 200 lines`,
    )
    // Notes sit between the brief and the requirement context.
    expect(prompt.indexOf('do a')).toBeLessThan(prompt.indexOf(PLAN_NOTES_HEADER))
    expect(prompt.indexOf(PLAN_NOTES_HEADER)).toBeLessThan(prompt.indexOf(PLAN_CONTEXT_HEADER))
  })

  it('steers a note on a running task straight into its agent', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()
    h.orchestrator.dispatch(planId, tasks[0].taskId)

    expect(h.orchestrator.note(planId, tasks[0].taskId, 'also add tests')).toBe(true)

    expect(h.steer).toHaveBeenCalledWith('sess0', `${PLAN_STEER_HEADER}\nalso add tests`)
    expect(h.emit).toHaveBeenCalledWith('plan.task.noted', {
      planId,
      taskId: tasks[0].taskId,
      note: 'also add tests',
    })
  })

  it('refuses notes on unknown tasks and blank notes', () => {
    const h = harness()
    const { planId, tasks } = h.createChain()

    expect(h.orchestrator.note('plan_ghost', tasks[0].taskId, 'x')).toBe(false)
    expect(h.orchestrator.note(planId, 'task_ghost', 'x')).toBe(false)
    expect(h.orchestrator.note(planId, tasks[0].taskId, '   ')).toBe(false)
    expect(h.types()).not.toContain('plan.task.noted')
  })

  it('reconciles notes and sessions: a restart rides notes on dispatch and steers late ones', () => {
    const first = harness()
    const { planId, tasks } = first.createChain()
    first.orchestrator.note(planId, tasks[0].taskId, 'remember the migration')

    // Restart before dispatch: the reconciled note rides the prompt.
    const second = harness()
    second.orchestrator.reconcile(first.log)
    second.orchestrator.dispatch(planId, tasks[0].taskId)
    expect(second.startTask.mock.calls[0][0]).toContain('remember the migration')

    // Restart after dispatch: the task↔session link survives, so a late note
    // still steers into the (resumable) agent.
    const third = harness()
    third.orchestrator.reconcile([...first.log, ...second.log])
    third.orchestrator.note(planId, tasks[0].taskId, 'late thought')
    expect(third.steer).toHaveBeenCalledWith('sess0', `${PLAN_STEER_HEADER}\nlate thought`)
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
