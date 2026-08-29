import { createEntityId } from '../shared/events'
import type { EventPayloads, PlanTaskSpec, StoredEvent } from '../shared/events'
import type { EmitStored } from './approvals'
import type { DecomposedTask } from './planDecomposer'

/** Prefixes the plan's requirement when a task is handed to its agent, so the
 * agent sees the larger goal its task serves. */
export const PLAN_CONTEXT_HEADER = '--- The requirement this task belongs to ---'

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

/** The sub-graph's leaves: expansion tasks no OTHER expansion task waits on.
 * Downstream work rewires onto these, so the whole sub-plan gates it. */
export function expansionLeaves(tasks: PlanTaskSpec[]): string[] {
  const ids = new Set(tasks.map((task) => task.taskId))
  const depended = new Set(tasks.flatMap((task) => task.dependsOn.filter((dep) => ids.has(dep))))
  return tasks.filter((task) => !depended.has(task.taskId)).map((task) => task.taskId)
}

/** Splice an expansion into a task list: the sub-tasks take the parent's
 * position, and every task that waited on the parent now waits on the
 * sub-graph's leaves. Deterministic from the event payload alone, so the
 * orchestrator's reconcile and the renderer's reducer replay it identically. */
export function spliceExpansion(
  tasks: PlanTaskSpec[],
  taskId: string,
  expansion: PlanTaskSpec[],
): PlanTaskSpec[] {
  const index = tasks.findIndex((task) => task.taskId === taskId)
  if (index === -1) {
    return tasks // a hand-built log expanding a ghost — nothing to splice
  }
  const leaves = expansionLeaves(expansion)
  const rewired = tasks.map((task) =>
    task.dependsOn.includes(taskId)
      ? {
          ...task,
          dependsOn: [...task.dependsOn.filter((dep) => dep !== taskId), ...leaves],
        }
      : task,
  )
  return [...rewired.slice(0, index), ...copyTasks(expansion), ...rewired.slice(index + 1)]
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
  /** pipelineId → `${planId}:${taskId}` for tasks running AS pipelines, so a
   * pipeline finishing resolves its task. Entries drop when the task does. */
  readonly #byPipeline = new Map<string, string>()
  readonly #startPipeline: (prompt: string) => string

  constructor(options: {
    emit: EmitStored
    store: PlanReader
    /** Launch a task's agent, under an agent-type preset when one is set. */
    startTask: (prompt: string, agentTypeId?: string) => string
    /** Launch a task as a full Plan→Implement→Review pipeline instead. */
    startPipeline: (prompt: string) => string
  }) {
    this.#emit = options.emit
    this.#store = options.store
    this.#startTask = options.startTask
    this.#startPipeline = options.startPipeline
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
    const sessionId = this.#startTask(
      `${task.prompt}\n\n${PLAN_CONTEXT_HEADER}\n${plan.requirement}`,
      task.agentTypeId,
    )
    this.#dispatched.add(key)
    this.#emit('plan.task.dispatched', { planId, taskId, sessionId })
    return sessionId
  }

  /** Launch a ready task as a full Plan→Implement→Review pipeline (shared
   * worktree, human gates, review workbench) instead of a single agent —
   * returning the new pipeline id, or null under the same guards as
   * {@link dispatch}. The task completes when the pipeline completes. */
  dispatchPipeline(planId: string, taskId: string): string | null {
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
    const pipelineId = this.#startPipeline(
      `${task.prompt}\n\n${PLAN_CONTEXT_HEADER}\n${plan.requirement}`,
    )
    this.#dispatched.add(key)
    this.#byPipeline.set(pipelineId, key)
    this.#emit('plan.task.pipelined', { planId, taskId, pipelineId })
    return pipelineId
  }

  /** A task's brief, for feeding back through the decomposer — or null when
   * the task is unknown or already launched (too late to restructure). */
  taskBrief(planId: string, taskId: string): string | null {
    const task = this.#plans.get(planId)?.tasks.find((candidate) => candidate.taskId === taskId)
    if (task === undefined || this.#dispatched.has(`${planId}:${taskId}`)) {
      return null
    }
    return task.prompt
  }

  /** Expand an undispatched task into a sub-plan IN PLACE: the decomposition's
   * tasks replace it at its position — their roots inherit the task's
   * dependencies, and everything that waited on the task is rewired to wait
   * on the sub-graph's leaves. Refused (false) for an unknown/launched task
   * or an empty decomposition. */
  expand(planId: string, taskId: string, decomposed: DecomposedTask[]): boolean {
    const plan = this.#plans.get(planId)
    const task = plan?.tasks.find((candidate) => candidate.taskId === taskId)
    if (plan === undefined || task === undefined || decomposed.length === 0) {
      return false
    }
    if (this.#dispatched.has(`${planId}:${taskId}`)) {
      return false
    }
    const ids = decomposed.map(() => createEntityId('task'))
    const expansion: PlanTaskSpec[] = decomposed.map((sub, index) => {
      const internal = sub.dependsOn.map((dep) => ids[dep])
      const agentTypeId = sub.agentTypeId ?? task.agentTypeId
      return {
        taskId: ids[index],
        title: sub.title,
        prompt: sub.prompt,
        // Roots of the sub-graph stand where the parent stood — they inherit
        // its dependencies; deeper sub-tasks reach them transitively.
        dependsOn: internal.length === 0 ? [...task.dependsOn] : internal,
        ...(agentTypeId === undefined ? {} : { agentTypeId }),
      }
    })
    plan.tasks = spliceExpansion(plan.tasks, taskId, expansion)
    this.#emit('plan.task.expanded', { planId, taskId, tasks: expansion })
    return true
  }

  /** Rewrite a task's brief — the prompt its agent will run with. Refused
   * (false) for an unknown plan/task, a blank brief, or a task whose agent
   * already launched (its brief is history; steer the agent instead). */
  reprompt(planId: string, taskId: string, prompt: string): boolean {
    const plan = this.#plans.get(planId)
    const task = plan?.tasks.find((candidate) => candidate.taskId === taskId)
    const trimmed = prompt.trim()
    if (plan === undefined || task === undefined || trimmed === '') {
      return false
    }
    if (this.#dispatched.has(`${planId}:${taskId}`)) {
      return false
    }
    task.prompt = trimmed
    this.#emit('plan.task.reprompted', { planId, taskId, prompt: trimmed })
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
      } else if (event.type === 'plan.task.reprompted') {
        const { planId, taskId, prompt } = event.payload as EventPayloads['plan.task.reprompted']
        const task = this.#plans.get(planId)?.tasks.find((t) => t.taskId === taskId)
        if (task !== undefined) {
          task.prompt = prompt
        }
      } else if (event.type === 'plan.task.expanded') {
        const { planId, taskId, tasks } = event.payload as EventPayloads['plan.task.expanded']
        const plan = this.#plans.get(planId)
        if (plan !== undefined) {
          plan.tasks = spliceExpansion(plan.tasks, taskId, tasks)
        }
      } else if (event.type === 'plan.task.dispatched') {
        const { planId, taskId } = event.payload as EventPayloads['plan.task.dispatched']
        this.#dispatched.add(`${planId}:${taskId}`)
      } else if (event.type === 'plan.task.pipelined') {
        const { planId, taskId, pipelineId } = event.payload as EventPayloads['plan.task.pipelined']
        this.#dispatched.add(`${planId}:${taskId}`)
        this.#byPipeline.set(pipelineId, `${planId}:${taskId}`)
      } else if (event.type === 'plan.task.completed') {
        const { planId, taskId } = event.payload as EventPayloads['plan.task.completed']
        this.#completed.add(`${planId}:${taskId}`)
        this.#dropPipelineFor(`${planId}:${taskId}`)
      } else if (event.type === 'plan.task.failed') {
        const { planId, taskId } = event.payload as EventPayloads['plan.task.failed']
        this.#dispatched.delete(`${planId}:${taskId}`)
        this.#dropPipelineFor(`${planId}:${taskId}`)
      }
    }
  }

  /** Forget any pipeline↔task link once the task has resolved, so stray later
   * pipeline events (e.g. a revise loop after failure) change nothing. */
  #dropPipelineFor(key: string): void {
    for (const [pipelineId, mapped] of this.#byPipeline) {
      if (mapped === key) {
        this.#byPipeline.delete(pipelineId)
      }
    }
  }

  /**
   * React to a task's work finishing. A single-agent task completes when its
   * agent goes idle (a finished turn — the agent stays alive for follow-ups)
   * or ends "completed"; a pipelined task completes when its pipeline
   * completes (every stage done, gates and all). Completing may put dependent
   * tasks on the ready frontier. A cancelled/failed agent — or a failed
   * pipeline — marks the task failed and reopens it for dispatch (a retry).
   */
  observe(event: StoredEvent): void {
    if (event.type === 'pipeline.completed' || event.type === 'pipeline.failed') {
      this.#observePipeline(event)
      return
    }
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

  /** Resolve a pipelined task from its pipeline's outcome. Unknown pipelines
   * (not launched from a plan, or already resolved) change nothing; a removed
   * plan's stray pipelines likewise. */
  #observePipeline(event: StoredEvent): void {
    const { pipelineId } = event.payload as { pipelineId: string }
    const key = this.#byPipeline.get(pipelineId)
    if (key === undefined) {
      return
    }
    const [planId, taskId] = key.split(':')
    if (!this.#plans.has(planId)) {
      return // plan was removed — its stray pipelines resolve nothing
    }
    this.#byPipeline.delete(pipelineId)
    if (event.type === 'pipeline.failed') {
      // Reopen the task so it can be dispatched again (either way).
      this.#dispatched.delete(key)
      this.#emit('plan.task.failed', { planId, taskId })
      return
    }
    this.#completed.add(key)
    this.#emit('plan.task.completed', { planId, taskId })
  }
}
