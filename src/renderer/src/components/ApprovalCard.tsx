import { useEffect, useState } from 'react'

import { DENY_GRACE_MS } from '../../../shared/bridge'
import type { PendingApproval } from '../../../shared/bridge'
import { compactInput } from '../timeline/timelineFormat'

const GRACE_SECONDS = Math.round(DENY_GRACE_MS / 1000)

/**
 * One approval request. Approve commits immediately (the card unmounts when
 * the parent sees the committed approval.resolved event). Deny starts a grace
 * countdown during which Undo returns the card to its pending state — a
 * mis-clicked deny never reaches the agent.
 */
export function ApprovalCard({
  approval,
  onResolve,
  onUndo,
}: {
  approval: PendingApproval
  onResolve: (approved: boolean) => void
  onUndo: () => void
}): React.JSX.Element {
  const [denying, setDenying] = useState(false)
  const [remaining, setRemaining] = useState(GRACE_SECONDS)

  useEffect(() => {
    if (!denying) {
      return
    }
    setRemaining(GRACE_SECONDS)
    const interval = setInterval(() => {
      setRemaining((previous) => Math.max(0, previous - 1))
    }, 1000)
    return () => {
      clearInterval(interval)
    }
  }, [denying])

  const undo = (): void => {
    setDenying(false)
    onUndo()
  }

  return (
    <div className="approval-card">
      <p className="approval-what">
        {approval.tool} {compactInput(approval.input)}
      </p>
      {denying ? (
        <div className="approval-actions approval-resolving">
          <span className="resolving-denied">Denying · {remaining}s</span>
          <button type="button" className="undo-button" onClick={undo}>
            Undo
          </button>
        </div>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="approve-button"
            onClick={() => {
              onResolve(true)
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="deny-button"
            onClick={() => {
              setDenying(true)
              onResolve(false)
            }}
          >
            Deny
          </button>
        </div>
      )}
    </div>
  )
}
