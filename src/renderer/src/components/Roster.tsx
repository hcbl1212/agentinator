import { useEffect, useState } from 'react'

import type { PendingApproval } from '../../../shared/bridge'
import type { EventPayloads } from '../../../shared/events'
import { ApprovalCard } from './ApprovalCard'

export function Roster(): React.JSX.Element {
  const bridge = window.agentinator
  const [prompt, setPrompt] = useState('')
  const [dispatched, setDispatched] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])

  useEffect(() => {
    const mounted = window.agentinator
    if (mounted === undefined) {
      return
    }
    let cancelled = false
    void mounted.approvals.pending().then((pending) => {
      if (!cancelled) {
        setApprovals(pending)
      }
    })
    const unsubscribe = mounted.events.onAppended((event) => {
      if (event.type === 'approval.requested') {
        const payload = event.payload as EventPayloads['approval.requested']
        setApprovals((previous) =>
          previous.some((approval) => approval.requestId === payload.requestId)
            ? previous
            : [...previous, payload],
        )
      } else if (event.type === 'approval.resolved') {
        const payload = event.payload as EventPayloads['approval.resolved']
        setApprovals((previous) =>
          previous.filter((approval) => approval.requestId !== payload.requestId),
        )
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const runTask = (submitEvent: React.FormEvent): void => {
    submitEvent.preventDefault()
    const trimmed = prompt.trim()
    if (bridge === undefined || trimmed === '') {
      return
    }
    void bridge.agent.startTask(trimmed)
    setDispatched('Task dispatched to Claude — watch it work in the timeline.')
    setPrompt('')
  }

  return (
    <aside className="pane roster" aria-label="Agent roster">
      <h2 className="pane-label">Agents</h2>
      {bridge === undefined ? (
        <p className="empty-state">No agents yet.</p>
      ) : (
        <>
          <form className="task-launcher" onSubmit={runTask}>
            <textarea
              className="task-input"
              aria-label="Task for Claude"
              placeholder="Describe a task for Claude to do in this repo…"
              rows={3}
              value={prompt}
              onChange={(changed) => setPrompt(changed.target.value)}
            />
            <button type="submit" className="run-task-button" disabled={prompt.trim() === ''}>
              ▶ Run task (Claude)
            </button>
          </form>
          <button
            type="button"
            className="demo-button"
            onClick={() => {
              setDispatched('Demo dispatched — watch the log count in the status bar.')
              void bridge.agent.startDemo()
            }}
          >
            ▶ Run demo (mock)
          </button>
        </>
      )}
      {dispatched !== null && <p className="empty-state">{dispatched}</p>}
      {approvals.length > 0 && (
        <div className="approvals" aria-label="Pending approvals">
          <h2 className="pane-label">Needs approval</h2>
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.requestId}
              approval={approval}
              onResolve={(approved) => void bridge?.approvals.resolve(approval.requestId, approved)}
              onUndo={() => void bridge?.approvals.undo(approval.requestId)}
            />
          ))}
        </div>
      )}
    </aside>
  )
}
