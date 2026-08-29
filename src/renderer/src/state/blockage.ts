import type { Pipeline } from './pipelines'
import type { Plan, PlanTaskView } from './plans'

/** How many tasks sit transitively downstream of `taskId` — everything that
 * cannot start (directly or through a chain) until it finishes. This is what
 * an inbox item blocking that task is really blocking. */
export function downstreamCount(taskId: string, tasks: PlanTaskView[]): number {
  const dependents = new Set<string>()
  const walk = (id: string): void => {
    for (const task of tasks) {
      if (task.dependsOn.includes(id) && !dependents.has(task.id)) {
        dependents.add(task.id)
        walk(task.id)
      }
    }
  }
  walk(taskId)
  return dependents.size
}

/** The downstream blockage of the plan task a session is working — 0 when the
 * session isn't plan work (an ad-hoc agent) or blocks nothing. Sessions reach
 * tasks two ways: a single-agent dispatch links the session directly, and a
 * pipeline stage links through its pipeline. */
export function blockageOf(sessionId: string, plans: Plan[], pipelines: Pipeline[]): number {
  for (const plan of plans) {
    const direct = plan.tasks.find((task) => task.sessionId === sessionId)
    if (direct !== undefined) {
      return downstreamCount(direct.id, plan.tasks)
    }
  }
  const pipeline = pipelines.find((candidate) =>
    candidate.stages.some((stage) => stage.sessionId === sessionId),
  )
  if (pipeline !== undefined) {
    for (const plan of plans) {
      const pipelined = plan.tasks.find((task) => task.pipelineId === pipeline.id)
      if (pipelined !== undefined) {
        return downstreamCount(pipelined.id, plan.tasks)
      }
    }
  }
  return 0
}
