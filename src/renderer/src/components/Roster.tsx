import { useEffect, useState } from 'react'

import type { PendingApproval } from '../../../shared/bridge'
import type { EventPayloads } from '../../../shared/events'
import { compactInput } from '../timeline/timelineFormat'

export function Roster(): React.JSX.Element {
  const bridge = window.agentinator
  const [dispatched, setDispatched] = useState(false)
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

  return (
    <aside className="pane roster" aria-label="Agent roster">
      <h2 className="pane-label">Agents</h2>
      <p className="empty-state">No agents yet. Run the demo to watch events flow into the log.</p>
      {bridge !== undefined && (
        <button
          type="button"
          className="demo-button"
          onClick={() => {
            setDispatched(true)
            void bridge.agent.startDemo()
          }}
        >
          ▶ Run demo agent
        </button>
      )}
      {dispatched && (
        <p className="empty-state">Demo dispatched — watch the log count in the status bar.</p>
      )}
      {approvals.length > 0 && (
        <div className="approvals" aria-label="Pending approvals">
          <h2 className="pane-label">Needs approval</h2>
          {approvals.map((approval) => (
            <div key={approval.requestId} className="approval-card">
              <p className="approval-what">
                {approval.tool} {compactInput(approval.input)}
              </p>
              <div className="approval-actions">
                <button
                  type="button"
                  className="approve-button"
                  onClick={() => void bridge?.approvals.resolve(approval.requestId, true)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="deny-button"
                  onClick={() => void bridge?.approvals.resolve(approval.requestId, false)}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
