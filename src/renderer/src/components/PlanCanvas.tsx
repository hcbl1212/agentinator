import { useState } from 'react'

import { useAgentTypes } from '../state/agentTypes'
import { usePlans } from '../state/plans'
import type { Plan, PlanTaskView } from '../state/plans'
import { useSelection } from '../state/selection'
import { taskDepth } from './Planner'

/** Node geometry: fixed-size chips laid out in columns by dependency depth.
 * Wide enough for the title plus the role picker beside the action buttons. */
const NODE_W = 210
const NODE_H = 34
const GAP_X = 48
const GAP_Y = 14
const PAD = 10

interface NodeBox {
  task: PlanTaskView
  x: number
  y: number
}

/** Column-per-depth layout: a task sits one column right of its deepest
 * dependency, rows in stored order — a readable left-to-right DAG without a
 * solver. */
export function layoutNodes(tasks: PlanTaskView[]): NodeBox[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const rows = new Map<number, number>()
  return tasks.map((task) => {
    const depth = taskDepth(task, byId)
    const row = rows.get(depth) ?? 0
    rows.set(depth, row + 1)
    return {
      task,
      x: PAD + depth * (NODE_W + GAP_X),
      y: PAD + row * (NODE_H + GAP_Y),
    }
  })
}

/** The task plus everything upstream (transitive dependencies) and downstream
 * (transitive dependents) of it — the chain a click traces. */
export function chainOf(taskId: string, tasks: PlanTaskView[]): Set<string> {
  const chain = new Set([taskId])
  const up = (id: string): void => {
    for (const dep of tasks.find((task) => task.id === id)?.dependsOn ?? []) {
      if (!chain.has(dep)) {
        chain.add(dep)
        up(dep)
      }
    }
  }
  const down = (id: string): void => {
    for (const task of tasks) {
      if (task.dependsOn.includes(id) && !chain.has(task.id)) {
        chain.add(task.id)
        down(task.id)
      }
    }
  }
  up(taskId)
  down(taskId)
  return chain
}

const CANVAS_MARK: Record<
  'ready' | 'blocked' | Exclude<PlanTaskView['status'], 'pending'>,
  string
> = {
  ready: '○',
  blocked: '◌',
  running: '◐',
  done: '●',
  failed: '✕',
}

/**
 * The editable DAG canvas (the stream's idle slot): the selected plan's task
 * graph as nodes in dependency-depth columns with curved edges. Click a node
 * to inspect it — its chain stays lit while the rest dims, and a detail card
 * opens beneath the graph with the task's full brief (the prompt its agent
 * will run with) and a comment box: notes accumulate on the task, ride the
 * prompt at dispatch, and steer straight into the agent when it's already
 * running. "Link" arms a node as a dependency source; clicking another node
 * then draws the edge, and ✕ on an edge erases it — both guarded upstream (no
 * cycles, no editing dispatched tasks). Ready nodes dispatch straight from
 * the canvas.
 */
export function PlanCanvas(): React.JSX.Element {
  const { plans } = usePlans()
  const { types } = useAgentTypes()
  const { selection, select } = useSelection()
  const [traced, setTraced] = useState<string | null>(null)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)

  const selected = selection?.kind === 'plan' ? plans.find((p) => p.id === selection.id) : undefined
  // Fall back to the newest plan so the canvas is useful even when the
  // selected plan was cleared out from under it.
  const plan: Plan | undefined = selected ?? plans[plans.length - 1]

  if (plan === undefined) {
    return (
      <section className="plan-canvas" aria-label="Plan canvas">
        <p className="rail-empty">No plan yet. Plan a requirement in the Planner pane first.</p>
      </section>
    )
  }

  const nodes = layoutNodes(plan.tasks)
  const boxes = new Map(nodes.map((node) => [node.task.id, node]))
  const doneIds = new Set(plan.tasks.filter((task) => task.status === 'done').map((t) => t.id))
  const chain = traced === null ? null : chainOf(traced, plan.tasks)
  const inspected = traced === null ? undefined : plan.tasks.find((task) => task.id === traced)
  const linkSource = linkFrom === null ? undefined : boxes.get(linkFrom)?.task
  const width = Math.max(...nodes.map((node) => node.x)) + NODE_W + PAD
  const height = Math.max(...nodes.map((node) => node.y)) + NODE_H + PAD

  const clickNode = (task: PlanTaskView): void => {
    if (linkSource !== undefined) {
      // Complete the link: the clicked task now waits on the armed source.
      if (task.id !== linkSource.id) {
        void window.agentinator?.planner.addEdge(plan.id, task.id, linkSource.id)
      }
      setLinkFrom(null)
      return
    }
    setTraced((current) => (current === task.id ? null : task.id))
  }

  const dispatch = (task: PlanTaskView): void => {
    void window.agentinator?.planner.dispatch(plan.id, task.id).then((sessionId) => {
      if (sessionId !== null) {
        select({ kind: 'session', id: sessionId })
      }
    })
  }

  // A hand-built log could reference a task the plan doesn't carry; such an
  // edge has nowhere to draw, so it's skipped rather than guarded per-render.
  const edges = plan.tasks.flatMap((task) =>
    task.dependsOn
      .filter((dep) => boxes.has(dep))
      .map((dep) => ({ from: boxes.get(dep) as NodeBox, to: boxes.get(task.id) as NodeBox })),
  )

  return (
    <section className="plan-canvas" aria-label="Plan canvas">
      <div className="plan-canvas-head">
        <span className="pipeline-title" title={plan.requirement}>
          {plan.title}
        </span>
        {linkSource !== undefined && (
          <span className="plan-canvas-hint" role="status">
            Linking from {linkSource.title} — click the task that should wait on it
          </span>
        )}
      </div>
      <div className="plan-canvas-scroll">
        <div className="plan-canvas-board" style={{ width: `${width}px`, height: `${height}px` }}>
          <svg className="plan-canvas-edges" width={width} height={height} aria-hidden="true">
            {edges.map(({ from: a, to: b }) => {
              const x1 = a.x + NODE_W
              const y1 = a.y + NODE_H / 2
              const x2 = b.x
              const y2 = b.y + NODE_H / 2
              const mid = (x1 + x2) / 2
              const dimmed = chain !== null && !(chain.has(a.task.id) && chain.has(b.task.id))
              return (
                <path
                  key={`${a.task.id}:${b.task.id}`}
                  className={`plan-edge${dimmed ? ' is-dimmed' : ''}`}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                />
              )
            })}
          </svg>
          {edges.map(({ from: a, to: b }) => {
            const label = `Remove dependency ${a.task.title} → ${b.task.title}`
            return (
              <button
                key={`${a.task.id}:${b.task.id}`}
                type="button"
                className="plan-edge-remove"
                style={{
                  left: `${(a.x + NODE_W + b.x) / 2 - 8}px`,
                  top: `${(a.y + b.y + NODE_H) / 2 - 8}px`,
                }}
                aria-label={label}
                title={label}
                onClick={() =>
                  void window.agentinator?.planner.removeEdge(plan.id, b.task.id, a.task.id)
                }
              >
                ✕
              </button>
            )
          })}
          {nodes.map(({ task, x, y }) => {
            const ready = task.dependsOn.every((dep) => doneIds.has(dep))
            const dispatchable = (task.status === 'pending' || task.status === 'failed') && ready
            const shown = task.status === 'pending' ? (ready ? 'ready' : 'blocked') : task.status
            const dimmed = chain !== null && !chain.has(task.id)
            // Retypeable exactly while the orchestrator would accept it: the
            // task's agent hasn't launched (pending, or reopened by failure).
            const retypeable = task.status === 'pending' || task.status === 'failed'
            const typeName =
              task.agentTypeId === undefined
                ? undefined
                : (types.find((type) => type.id === task.agentTypeId)?.name ?? task.agentTypeId)
            const bodyLabel =
              linkSource === undefined
                ? `Trace ${task.title}`
                : `Make ${task.title} depend on ${linkSource.title}`
            return (
              <div
                key={task.id}
                className={`plan-node is-${shown}${dimmed ? ' is-dimmed' : ''}`}
                style={{ left: `${x}px`, top: `${y}px`, width: `${NODE_W}px` }}
              >
                <button
                  type="button"
                  className="plan-node-body"
                  aria-label={bodyLabel}
                  title={
                    `${task.title} — ${shown}` + (typeName === undefined ? '' : ` · ${typeName}`)
                  }
                  onClick={() => clickNode(task)}
                >
                  <span className="pipeline-stage-mark" aria-hidden="true">
                    {CANVAS_MARK[shown]}
                  </span>
                  <span className="plan-node-title">{task.title}</span>
                </button>
                {retypeable ? (
                  <select
                    className="plan-node-type"
                    value={task.agentTypeId ?? ''}
                    aria-label={`Agent type for ${task.title}`}
                    title="The role this task dispatches under"
                    onChange={(event) =>
                      void window.agentinator?.planner.retype(
                        plan.id,
                        task.id,
                        event.target.value === '' ? null : event.target.value,
                      )
                    }
                  >
                    <option value="">Default</option>
                    {types.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  typeName !== undefined && (
                    <span className="plan-node-type-badge" title={`Ran as ${typeName}`}>
                      {typeName}
                    </span>
                  )
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
                <button
                  type="button"
                  className={`queue-action plan-node-link${linkFrom === task.id ? ' is-armed' : ''}`}
                  aria-label={
                    linkFrom === task.id
                      ? `Cancel link from ${task.title}`
                      : `Link from ${task.title}`
                  }
                  title="Draw a dependency from this task"
                  onClick={() => setLinkFrom((current) => (current === task.id ? null : task.id))}
                >
                  ⇢
                </button>
              </div>
            )
          })}
        </div>
      </div>
      {inspected !== undefined && (
        <TaskDetail key={inspected.id} plan={plan} task={inspected} types={types} />
      )}
    </section>
  )
}

/** The inspected task's card: its full brief (the prompt its agent runs
 * with), dependencies, role, accumulated notes, and the comment box. Keyed by
 * task so switching nodes resets the draft note. */
function TaskDetail({
  plan,
  task,
  types,
}: {
  plan: Plan
  task: PlanTaskView
  types: { id: string; name: string }[]
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const blockers = task.dependsOn
    .map((dep) => byId.get(dep)?.title)
    .filter((title): title is string => title !== undefined)
  // The same state language as the nodes: pending splits into ready/blocked.
  const ready = task.dependsOn.every((dep) => byId.get(dep)?.status === 'done')
  const shown = task.status === 'pending' ? (ready ? 'ready' : 'blocked') : task.status
  const typeName =
    task.agentTypeId === undefined
      ? 'Default agent'
      : (types.find((type) => type.id === task.agentTypeId)?.name ?? task.agentTypeId)

  const add = (): void => {
    const trimmed = note.trim()
    if (trimmed === '') {
      return
    }
    void window.agentinator?.planner.note(plan.id, task.id, trimmed)
    setNote('')
  }

  return (
    <section className="plan-task-detail" aria-label={`Task details: ${task.title}`}>
      <div className="plan-task-detail-head">
        <span className="pipeline-title" title={task.title}>
          {task.title}
        </span>
        <span className="plan-task-detail-meta">
          {shown} · {typeName}
          {blockers.length === 0 ? '' : ` · after ${blockers.join(', ')}`}
        </span>
      </div>
      <pre className="plan-task-detail-prompt">{task.prompt}</pre>
      {task.notes.length > 0 && (
        <ul className="plan-task-notes" aria-label={`Notes on ${task.title}`}>
          {task.notes.map((text, index) => (
            <li key={index} className="plan-task-note">
              {text}
            </li>
          ))}
        </ul>
      )}
      <form
        className="plan-form"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <input
          className="plan-form-input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={
            task.status === 'running'
              ? 'Comment — goes straight to the running agent…'
              : 'Comment — rides the prompt when this task dispatches…'
          }
          aria-label={`Note for ${task.title}`}
        />
        <button type="submit" className="plan-form-send">
          Add note
        </button>
      </form>
    </section>
  )
}
