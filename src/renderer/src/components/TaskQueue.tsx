import { useQueue } from '../state/queue'
import type { QueuedTask } from '../state/queue'
import { useSelection } from '../state/selection'

/**
 * The task backlog: prompts parked (via the composer's Queue button) to launch
 * later. Dispatch one to fire it as an agent — the new agent is selected so the
 * stream follows it — or remove it. Fed live from the event log; order is the
 * order tasks were queued.
 */
export function TaskQueue(): React.JSX.Element {
  const { tasks } = useQueue()
  const { select } = useSelection()

  const dispatch = (task: QueuedTask): void => {
    void window.agentinator?.queue.dispatch(task.id, task.prompt).then((sessionId) => {
      select({ kind: 'session', id: sessionId })
    })
  }

  const remove = (taskId: string): void => {
    void window.agentinator?.queue.remove(taskId)
  }

  return (
    <section className="pane queue" aria-label="Task queue">
      <div className="rail-head">
        <h2 className="pane-label">Queue</h2>
        {tasks.length > 0 && <span className="queue-count">{tasks.length}</span>}
      </div>
      {tasks.length === 0 ? (
        <p className="rail-empty">
          Nothing queued. Type a task and press Queue to park it for later.
        </p>
      ) : (
        <ul className="queue-list">
          {tasks.map((task) => (
            <li key={task.id} className="queue-row">
              <span className="queue-prompt" title={task.prompt}>
                {task.prompt}
              </span>
              <span className="queue-actions">
                <button
                  type="button"
                  className="queue-action"
                  aria-label={`Dispatch ${task.prompt}`}
                  title="Dispatch to an agent"
                  onClick={() => dispatch(task)}
                >
                  ▶
                </button>
                <button
                  type="button"
                  className="queue-action"
                  aria-label={`Remove ${task.prompt}`}
                  title="Remove from queue"
                  onClick={() => remove(task.id)}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
