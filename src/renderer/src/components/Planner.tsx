import { useState } from 'react'

import { usePlans } from '../state/plans'
import type { Plan, PlanTaskView } from '../state/plans'
import { useSelection } from '../state/selection'

/** The glyph that encodes a task's shown state in form as well as colour. A
 * stored "pending" renders as ready or blocked, split by whether every
 * dependency is done — so "pending" itself never shows. */
const TASK_MARK: Record<'ready' | 'blocked' | Exclude<PlanTaskView['status'], 'pending'>, string> =
  {
    ready: '○',
    blocked: '◌',
    running: '◐',
    done: '●',
    failed: '✕',
  }

/** How deep a task sits in the dependency graph (0 = no dependencies) — the
 * tree indent. The graph is a DAG by construction, but a cycle in a hand-built
 * log must not hang the render, so visited nodes count as depth 0. */
export function taskDepth(task: PlanTaskView, byId: Map<string, PlanTaskView>): number {
  const walk = (current: PlanTaskView, seen: Set<string>): number => {
    if (current.dependsOn.length === 0 || seen.has(current.id)) {
      return 0
    }
    seen.add(current.id)
    const parents = current.dependsOn
      .map((dep) => byId.get(dep))
      .filter((parent): parent is PlanTaskView => parent !== undefined)
    return parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => walk(p, seen)))
  }
  return walk(task, new Set())
}

/**
 * The planner pane: describe a requirement and press Plan — the AI decomposes
 * it into a dependency-aware task list, rendered as a tree indented by depth.
 * Tasks with every dependency done form the "ready to start" frontier and carry
 * a dispatch button; a dispatched task's chip follows its agent live (clicking
 * it selects that agent), and a finished task may unlock its dependents. A
 * failed task returns to the frontier for a retry. Fed live from the event log.
 */
export function Planner(): React.JSX.Element {
  const { plans } = usePlans()
  const [requirement, setRequirement] = useState('')
  const [planning, setPlanning] = useState(false)

  const create = (): void => {
    const trimmed = requirement.trim()
    if (trimmed === '' || planning) {
      return
    }
    setPlanning(true)
    void window.agentinator?.planner
      .create(trimmed)
      .then(() => setRequirement(''))
      // Decomposition failed (e.g. the provider errored) — keep the text so
      // the user can retry, and free the button either way.
      .catch(() => undefined)
      .then(() => setPlanning(false))
  }

  return (
    <section className="pane planner" aria-label="Planner">
      <div className="rail-head">
        <h2 className="pane-label">Planner</h2>
        {plans.length > 0 && <span className="queue-count">{plans.length}</span>}
      </div>
      <form
        className="plan-form"
        onSubmit={(event) => {
          event.preventDefault()
          create()
        }}
      >
        <input
          className="plan-form-input"
          value={requirement}
          onChange={(event) => setRequirement(event.target.value)}
          placeholder="Describe a requirement…"
          aria-label="Requirement to plan"
          disabled={planning}
        />
        <button type="submit" className="plan-form-send" disabled={planning}>
          {planning ? 'Planning…' : 'Plan'}
        </button>
      </form>
      {plans.length === 0 ? (
        <p className="rail-empty">
          No plans yet. Describe a requirement and press Plan to break it into tasks.
        </p>
      ) : (
        <ul className="plan-list">
          {plans.map((plan) => (
            <PlanRow key={plan.id} plan={plan} />
          ))}
        </ul>
      )}
    </section>
  )
}

function PlanRow({ plan }: { plan: Plan }): React.JSX.Element {
  const { select } = useSelection()
  const byId = new Map(plan.tasks.map((task) => [task.id, task]))
  const doneIds = new Set(plan.tasks.filter((task) => task.status === 'done').map((t) => t.id))

  const dispatch = (task: PlanTaskView): void => {
    void window.agentinator?.planner.dispatch(plan.id, task.id).then((sessionId) => {
      if (sessionId !== null) {
        select({ kind: 'session', id: sessionId })
      }
    })
  }

  return (
    <li className="plan-row">
      <div className="pipeline-head">
        <span className="pipeline-title" title={plan.requirement}>
          {plan.title}
        </span>
        <button
          type="button"
          className="queue-action"
          aria-label={`Clear plan ${plan.title}`}
          title="Clear this plan"
          onClick={() => void window.agentinator?.planner.remove(plan.id)}
        >
          ✕
        </button>
      </div>
      <ol className="plan-tasks">
        {plan.tasks.map((task) => {
          const ready = task.dependsOn.every((dep) => doneIds.has(dep))
          // The frontier: never started (or failed) with every dependency done.
          const dispatchable = (task.status === 'pending' || task.status === 'failed') && ready
          const shown = task.status === 'pending' ? (ready ? 'ready' : 'blocked') : task.status
          const blockers = task.dependsOn
            .map((dep) => byId.get(dep)?.title)
            .filter((title): title is string => title !== undefined)
          const label =
            `${task.title} — ${shown}` +
            (blockers.length === 0 ? '' : ` · after ${blockers.join(', ')}`)
          const className = `plan-task is-${shown}`
          const mark = (
            <span className="pipeline-stage-mark" aria-hidden="true">
              {TASK_MARK[shown]}
            </span>
          )
          return (
            <li
              key={task.id}
              className="plan-task-item"
              style={{ paddingLeft: `${taskDepth(task, byId) * 14}px` }}
            >
              {task.sessionId === undefined ? (
                <span className={className} title={label} aria-label={label}>
                  {mark}
                  {task.title}
                </span>
              ) : (
                <button
                  type="button"
                  className={className}
                  title={`${label} — select its agent`}
                  aria-label={`${label} — select its agent`}
                  onClick={() => select({ kind: 'session', id: task.sessionId as string })}
                >
                  {mark}
                  {task.title}
                </button>
              )}
              {dispatchable && (
                <button
                  type="button"
                  className="queue-action"
                  aria-label={`Dispatch ${task.title}`}
                  title="Dispatch to an agent"
                  onClick={() => dispatch(task)}
                >
                  ▶
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </li>
  )
}
