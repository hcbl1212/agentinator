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
  const startTask = vi.fn<(prompt: string) => string>(() => `sess${n++}`)
  const orchestrator = new PlanOrchestrator({ emit, store, startTask })

  return {
    orchestrator,
    log,
    emit,
    startTask,
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
