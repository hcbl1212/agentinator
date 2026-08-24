import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { EventPayloads, StoredEvent } from '../../../shared/events'

/** A plan task as the UI shows it: its label, dependencies, how far along it
 * is, and (once dispatched) the agent session running it — so a click can jump
 * to that agent. Whether it's READY is derived from its siblings (every
 * dependency done), not stored. */
export interface PlanTaskView {
  id: string
  title: string
  /** The full brief the dispatched agent will run with. Editable until
   * dispatch (plan.task.reprompted); frozen once its agent launches. */
  prompt: string
  dependsOn: string[]
  status: 'pending' | 'running' | 'done' | 'failed'
  sessionId?: string
  /** Set when the task runs as a Plan→Implement→Review pipeline rather than a
   * single agent — the Pipelines rail carries its live stage chips. */
  pipelineId?: string
  /** The agent-type preset this task will dispatch under (undefined = the
   * default agent). Editable until dispatch. */
  agentTypeId?: string
}

/** A plan reduced from the log: its requirement and task graph. */
export interface Plan {
  id: string
  title: string
  requirement: string
  tasks: PlanTaskView[]
}

/** Replace one plan's task `taskId` via `patch`, leaving the rest alone. */
function patchTask(
  plans: Plan[],
  planId: string,
  taskId: string,
  patch: Partial<PlanTaskView>,
): Plan[] {
  return plans.map((plan) =>
    plan.id === planId
      ? {
          ...plan,
          tasks: plan.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
        }
      : plan,
  )
}

/**
 * Folds one event into the plan list: a plan appears with its whole task graph
 * when created, each task flips to running/done/failed as its agent starts and
 * finishes (a re-dispatched failed task flips back to running), and a removed
 * plan folds out.
 */
export function reducePlans(plans: Plan[], event: StoredEvent): Plan[] {
  switch (event.type) {
    case 'plan.created': {
      const payload = event.payload as EventPayloads['plan.created']
      return plans.some((plan) => plan.id === payload.planId)
        ? plans
        : [
            ...plans,
            {
              id: payload.planId,
              title: payload.title,
              requirement: payload.requirement,
              tasks: payload.tasks.map((task) => ({
                id: task.taskId,
                title: task.title,
                prompt: task.prompt,
                dependsOn: task.dependsOn,
                status: 'pending',
                ...(task.agentTypeId === undefined ? {} : { agentTypeId: task.agentTypeId }),
              })),
            },
          ]
    }
    case 'plan.task.dispatched': {
      const { planId, taskId, sessionId } = event.payload as EventPayloads['plan.task.dispatched']
      // A retry may switch mode — a fresh single-agent run clears any stale
      // pipeline link, and vice versa below.
      return patchTask(plans, planId, taskId, {
        status: 'running',
        sessionId,
        pipelineId: undefined,
      })
    }
    case 'plan.task.pipelined': {
      const { planId, taskId, pipelineId } = event.payload as EventPayloads['plan.task.pipelined']
      return patchTask(plans, planId, taskId, {
        status: 'running',
        pipelineId,
        sessionId: undefined,
      })
    }
    case 'plan.task.completed': {
      const { planId, taskId } = event.payload as EventPayloads['plan.task.completed']
      return patchTask(plans, planId, taskId, { status: 'done' })
    }
    case 'plan.task.failed': {
      const { planId, taskId } = event.payload as EventPayloads['plan.task.failed']
      return patchTask(plans, planId, taskId, { status: 'failed' })
    }
    case 'plan.edge.added': {
      const { planId, taskId, dependsOnTaskId } = event.payload as EventPayloads['plan.edge.added']
      return plans.map((plan) =>
        plan.id === planId
          ? {
              ...plan,
              tasks: plan.tasks.map((task) =>
                task.id === taskId && !task.dependsOn.includes(dependsOnTaskId)
                  ? { ...task, dependsOn: [...task.dependsOn, dependsOnTaskId] }
                  : task,
              ),
            }
          : plan,
      )
    }
    case 'plan.edge.removed': {
      const { planId, taskId, dependsOnTaskId } =
        event.payload as EventPayloads['plan.edge.removed']
      return plans.map((plan) =>
        plan.id === planId
          ? {
              ...plan,
              tasks: plan.tasks.map((task) =>
                task.id === taskId
                  ? { ...task, dependsOn: task.dependsOn.filter((d) => d !== dependsOnTaskId) }
                  : task,
              ),
            }
          : plan,
      )
    }
    case 'plan.task.retyped': {
      const { planId, taskId, agentTypeId } = event.payload as EventPayloads['plan.task.retyped']
      return plans.map((plan) =>
        plan.id === planId
          ? {
              ...plan,
              tasks: plan.tasks.map((task) => {
                if (task.id !== taskId) {
                  return task
                }
                if (agentTypeId === null) {
                  const cleared = { ...task }
                  delete cleared.agentTypeId
                  return cleared
                }
                return { ...task, agentTypeId }
              }),
            }
          : plan,
      )
    }
    case 'plan.task.reprompted': {
      const { planId, taskId, prompt } = event.payload as EventPayloads['plan.task.reprompted']
      return plans.map((plan) =>
        plan.id === planId
          ? {
              ...plan,
              tasks: plan.tasks.map((task) => (task.id === taskId ? { ...task, prompt } : task)),
            }
          : plan,
      )
    }
    case 'plan.removed': {
      const { planId } = event.payload as EventPayloads['plan.removed']
      return plans.filter((plan) => plan.id !== planId)
    }
    default:
      return plans
  }
}

interface PlanListState {
  plans: Plan[]
}

const PlanContext = createContext<PlanListState | null>(null)

/** Derives the plan list from the append-only log and shares it. */
export function PlanProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [plans, setPlans] = useState<Plan[]>([])

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.tail(500).then((page) => {
      if (!cancelled) {
        setPlans((previous) => page.reduce(reducePlans, previous))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setPlans((previous) => reducePlans(previous, event))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo(() => ({ plans }), [plans])
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>
}

export function usePlans(): PlanListState {
  const state = useContext(PlanContext)
  if (state === null) {
    throw new Error('usePlans must be used within a PlanProvider')
  }
  return state
}
