import { createEntityId } from '../shared/events'
import type { EventPayloads, PlanTaskSpec, StoredEvent } from '../shared/events'
import type { EmitStored } from './approvals'
import type { DecomposedTask } from './planDecomposer'

/** Prefixes the plan's requirement when a task is handed to its agent, so the
 * agent sees the larger goal its task serves. */
export const PLAN_CONTEXT_HEADER = '--- The requirement this task belongs to ---'

/** Prefixes the user's accumulated notes when a task dispatches with them. */
export const PLAN_NOTES_HEADER = '--- Notes from the user on this task ---'

/** Prefixes a note steered into a task's already-running agent. */
export const PLAN_STEER_HEADER = '--- A note from the user on your task ---'

/** What the orchestrator needs from the event store: a session's events, which
 * carry its `plan.task.dispatched` (so a finished session maps back to its
 * task) and any earlier resolution (the idempotency check). */
type PlanReader = { listBySession(sessionId: string): StoredEvent[] }

interface PlanState {
  requirement: string
  tasks: PlanTaskSpec[]
}

/** A private deep copy of a task list, so edge edits mutate orchestrator state
 * without reaching back into logged event payloads. */
function copyTasks(tasks: PlanTaskSpec[]): PlanTaskSpec[] {
  return tasks.map((task) => ({ ...task, dependsOn: [...task.dependsOn] }))
}

/**
 * Runs plans: a requirement decomposed into a task DAG, dispatched task by task
 * as the user fires the ready frontier. {@link dispatch} launches one ready
 * task (every dependency completed) as an agent; {@link observe} marks the task
 * completed when that agent finishes a turn — which may unlock dependents —
 * or failed when it's cancelled/errors (the task can then be dispatched again).
 * Unlike a pipeline stage, a finished task's agent is NOT retired: plan tasks
 * are ordinary agents the user may keep steering. State lives in memory and is
 * rebuilt from the log via {@link reconcile} so a plan survives a restart.
 */
export class PlanOrchestrator {
  readonly #emit: EmitStored
  readonly #store: PlanReader
  readonly #startTask: (prompt: string, agentTypeId?: string) => string
  readonly #plans = new Map<string, PlanState>()
  /** `${planId}:${taskId}` for every task in flight or done, so a double
   * Dispatch can't launch the same task twice. A failed task is removed again
   * — failure unlocks a retry, not a dead end. */
  readonly #dispatched = new Set<string>()
  /** `${planId}:${taskId}` for every completed task — the dependency check. */
  readonly #completed = new Set<string>()
  /** Accumulated user notes per task — appended to the prompt at dispatch. */
  readonly #notes = new Map<string, string[]>()
  /** The session running each dispatched task, so a later note can be steered
   * into the live agent. */
  readonly #sessions = new Map<string, string>()
  readonly #steer: (sessionId: string, text: string) => void

  constructor(options: {
    emit: EmitStored
    store: PlanReader
    /** Launch a task's agent, under an agent-type preset when one is set. */
    startTask: (prompt: string, agentTypeId?: string) => string
    /** Send a message into a task's already-running session (a note arriving
     * after dispatch). */
    steer: (sessionId: string, text: string) => void
  }) {
    this.#emit = options.emit
    this.#store = options.store
    this.#startTask = options.startTask
    this.#steer = options.steer
  }

  /** Record a decomposed requirement as a plan: mint stable task ids, map the
   * decomposition's index-based dependencies onto them, and log the whole
   * graph. Nothing dispatches until the user fires a ready task. */
  create(title: string, requirement: string, decomposed: DecomposedTask[]): string {
    const planId = createEntityId('plan')
    const ids = decomposed.map(() => createEntityId('task'))
    const tasks: PlanTaskSpec[] = decomposed.map((task, index) => ({
      taskId: ids[index],
      title: task.title,
      prompt: task.prompt,
      dependsOn: task.dependsOn.map((dep) => ids[dep]),
      ...(task.agentTypeId === undefined ? {} : { agentTypeId: task.agentTypeId }),
    }))
    this.#plans.set(planId, { requirement, tasks: copyTasks(tasks) })
    this.#emit('plan.created', { planId, title, requirement, tasks })
    return planId
  }

  /** Draw a dependency edge: `taskId` will also wait on `dependsOnTaskId`.
   * Refused (false) when either task is unknown, the edge is a self-loop or
   * already present, the dependent task has already been dispatched (its agent
   * launched under the old graph), or the edge would close a cycle. */
  addEdge(planId: string, taskId: string, dependsOnTaskId: string): boolean {
    const plan = this.#plans.get(planId)
    const task = plan?.tasks.find((candidate) => candidate.taskId === taskId)
    const dependency = plan?.tasks.find((candidate) => candidate.taskId === dependsOnTaskId)
    if (plan === undefined || task === undefined || dependency === undefined) {
      return false
    }
    if (taskId === dependsOnTaskId || task.dependsOn.includes(dependsOnTaskId)) {
      return false
    }
    if (this.#dispatched.has(`${planId}:${taskId}`)) {
      return false
    }
    // A cycle would exist iff taskId is already upstream of dependsOnTaskId —
    // walk the dependency's ancestors before accepting.
    if (this.#upstreamOf(plan, dependsOnTaskId).has(taskId)) {
      return false
    }
    task.dependsOn.push(dependsOnTaskId)
    this.#emit('plan.edge.added', { planId, taskId, dependsOnTaskId })
    return true
  }

  /** Erase a dependency edge, which may put `taskId` on the ready frontier.
   * Refused (false) when the edge doesn't exist or the dependent task has
   * already been dispatched (nothing left for the edge to gate). */
  removeEdge(planId: string, taskId: string, dependsOnTaskId: string): boolean {
    const plan = this.#plans.get(planId)
    const task = plan?.tasks.find((candidate) => candidate.taskId === taskId)
    if (plan === undefined || task === undefined || !task.dependsOn.includes(dependsOnTaskId)) {
      return false
    }
    if (this.#dispatched.has(`${planId}:${taskId}`)) {
      return false
    }
    task.dependsOn = task.dependsOn.filter((dep) => dep !== dependsOnTaskId)
    this.#emit('plan.edge.removed', { planId, taskId, dependsOnTaskId })
    return true
  }

  /** Every task upstream of `taskId` (its transitive dependencies). */
  #upstreamOf(plan: PlanState, taskId: string): Set<string> {
    const seen = new Set<string>()
    const walk = (id: string): void => {
      const task = plan.tasks.find((candidate) => candidate.taskId === id)
      for (const dep of task?.dependsOn ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep)
          walk(dep)
        }
      }
    }
    walk(taskId)
    return seen
  }

  /** Launch a ready task as an agent, returning the new session id — or null
   * when it isn't dispatchable (unknown plan/task, already in flight or done,
   * or a dependency hasn't completed). The renderer shows the same frontier,
   * but the guard lives here so a stale click can't jump the graph. */
  dispatch(planId: string, taskId: string): string | null {
    const plan = this.#plans.get(planId)
    const task = plan?.tasks.find((candidate) => candidate.taskId === taskId)
    if (plan === undefined || task === undefined) {
      return null
    }
    const key = `${planId}:${taskId}`
    if (this.#dispatched.has(key)) {
      return null
    }
    if (!task.dependsOn.every((dep) => this.#completed.has(`${planId}:${dep}`))) {
      return null
    }
    const notes = this.#notes.get(key) ?? []
    const parts = [task.prompt]
    if (notes.length > 0) {
      parts.push(`${PLAN_NOTES_HEADER}\n${notes.join('\n')}`)
    }
    parts.push(`${PLAN_CONTEXT_HEADER}\n${plan.requirement}`)
    const sessionId = this.#startTask(parts.join('\n\n'), task.agentTypeId)
    this.#dispatched.add(key)
    this.#sessions.set(key, sessionId)
    this.#emit('plan.task.dispatched', { planId, taskId, sessionId })
    return sessionId
  }

  /** Record a user note on a task. Before dispatch it accumulates and rides
   * the agent's prompt; on a task already running it is ALSO steered into the
   * live session, so the comment reaches the work either way. Refused (false)
   * for an unknown plan/task or a blank note. */
  note(planId: string, taskId: string, note: string): boolean {
    const plan = this.#plans.get(planId)
    const task = plan?.tasks.find((candidate) => candidate.taskId === taskId)
    const trimmed = note.trim()
    if (plan === undefined || task === undefined || trimmed === '') {
      return false
    }
    const key = `${planId}:${taskId}`
    const notes = this.#notes.get(key) ?? []
    notes.push(trimmed)
    this.#notes.set(key, notes)
    const sessionId = this.#sessions.get(key)
    if (this.#dispatched.has(key) && sessionId !== undefined) {
      this.#steer(sessionId, `${PLAN_STEER_HEADER}\n${trimmed}`)
    }
    this.#emit('plan.task.noted', { planId, taskId, note: trimmed })
    return true
  }

  /** Reassign which agent-type preset a task will dispatch under (null returns
   * it to the default agent). Refused (false) for an unknown plan/task or one
   * whose agent already launched — the type rode along at dispatch. */
  retype(planId: string, taskId: string, agentTypeId: string | null): boolean {
    const plan = this.#plans.get(planId)
    const task = plan?.tasks.find((candidate) => candidate.taskId === taskId)
    if (plan === undefined || task === undefined) {
      return false
    }
    if (this.#dispatched.has(`${planId}:${taskId}`)) {
      return false
    }
    if (agentTypeId === null) {
      delete task.agentTypeId
    } else {
      task.agentTypeId = agentTypeId
    }
    this.#emit('plan.task.retyped', { planId, taskId, agentTypeId })
    return true
  }

  /** Clear a plan from the list. It stops tracking (a still-running task's
   * agent that later finishes finds no plan and is left alone) and drops out
   * of the UI. */
  remove(planId: string): void {
    this.#plans.delete(planId)
    this.#emit('plan.removed', { planId })
  }

  /** Rebuild in-memory plan state from the log (called at boot) so a plan in
   * flight before a restart keeps its graph, frontier, and double-dispatch
   * guards. A removed plan is forgotten so it neither advances nor reappears. */
  reconcile(events: StoredEvent[]): void {
    for (const event of events) {
      if (event.type === 'plan.created') {
        const payload = event.payload as EventPayloads['plan.created']
        this.#plans.set(payload.planId, {
          requirement: payload.requirement,
          tasks: copyTasks(payload.tasks),
        })
      } else if (event.type === 'plan.edge.added') {
        const { planId, taskId, dependsOnTaskId } =
          event.payload as EventPayloads['plan.edge.added']
        const task = this.#plans.get(planId)?.tasks.find((t) => t.taskId === taskId)
        task?.dependsOn.push(dependsOnTaskId)
      } else if (event.type === 'plan.edge.removed') {
        const { planId, taskId, dependsOnTaskId } =
          event.payload as EventPayloads['plan.edge.removed']
        const task = this.#plans.get(planId)?.tasks.find((t) => t.taskId === taskId)
        if (task !== undefined) {
          task.dependsOn = task.dependsOn.filter((dep) => dep !== dependsOnTaskId)
        }
      } else if (event.type === 'plan.task.retyped') {
        const { planId, taskId, agentTypeId } = event.payload as EventPayloads['plan.task.retyped']
        const task = this.#plans.get(planId)?.tasks.find((t) => t.taskId === taskId)
        if (task !== undefined) {
          if (agentTypeId === null) {
            delete task.agentTypeId
          } else {
            task.agentTypeId = agentTypeId
          }
        }
      } else if (event.type === 'plan.removed') {
        this.#plans.delete((event.payload as EventPayloads['plan.removed']).planId)
      } else if (event.type === 'plan.task.noted') {
        const { planId, taskId, note } = event.payload as EventPayloads['plan.task.noted']
        const key = `${planId}:${taskId}`
        const notes = this.#notes.get(key) ?? []
        notes.push(note)
        this.#notes.set(key, notes)
      } else if (event.type === 'plan.task.dispatched') {
        const { planId, taskId, sessionId } = event.payload as EventPayloads['plan.task.dispatched']
        this.#dispatched.add(`${planId}:${taskId}`)
        this.#sessions.set(`${planId}:${taskId}`, sessionId)
      } else if (event.type === 'plan.task.completed') {
        const { planId, taskId } = event.payload as EventPayloads['plan.task.completed']
        this.#completed.add(`${planId}:${taskId}`)
      } else if (event.type === 'plan.task.failed') {
        const { planId, taskId } = event.payload as EventPayloads['plan.task.failed']
        this.#dispatched.delete(`${planId}:${taskId}`)
      }
    }
  }

  /**
   * React to a task's agent finishing. A task completes when its agent goes
   * idle (a finished turn — the agent stays alive for follow-ups) or ends
   * "completed"; completing it may put dependent tasks on the ready frontier.
   * A session that ends cancelled/failed marks the task failed and reopens it
   * for dispatch (a retry with a fresh agent).
   */
  observe(event: StoredEvent): void {
    if (event.type !== 'session.idle' && event.type !== 'session.ended') {
      return
    }
    const sessionId = (event.payload as { sessionId: string }).sessionId
    const events = this.#store.listBySession(sessionId)
    const dispatched = events.find((e) => e.type === 'plan.task.dispatched')?.payload as
      EventPayloads['plan.task.dispatched'] | undefined
    if (dispatched === undefined) {
      return // not a plan task's agent
    }
    // Idempotency: this task already resolved through this session (completed
    // or failed) — don't record it twice. Both carry the sessionId, so they're
    // in the session index.
    if (events.some((e) => e.type === 'plan.task.completed' || e.type === 'plan.task.failed')) {
      return
    }
    const { planId, taskId } = dispatched
    if (!this.#plans.has(planId)) {
      return // plan was removed — its stray agents resolve nothing
    }
    const key = `${planId}:${taskId}`
    if (
      event.type === 'session.ended' &&
      (event.payload as EventPayloads['session.ended']).outcome !== 'completed'
    ) {
      // Reopen the task so it can be dispatched again with a fresh agent.
      this.#dispatched.delete(key)
      this.#emit('plan.task.failed', { planId, taskId, sessionId })
      return
    }
    this.#completed.add(key)
    this.#emit('plan.task.completed', { planId, taskId, sessionId })
  }
}
