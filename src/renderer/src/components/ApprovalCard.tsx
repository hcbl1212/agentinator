import { useEffect, useState } from 'react'

import { APPROVAL_GRACE_MS } from '../../../shared/bridge'
import type { PendingApproval } from '../../../shared/bridge'
import { compactInput } from '../timeline/timelineFormat'

const GRACE_SECONDS = Math.round(APPROVAL_GRACE_MS / 1000)

/**
 * One approval request. A decision doesn't reach the agent immediately —
 * clicking Approve/Deny starts a grace countdown during which Undo returns
 * the card to its pending state. The card unmounts once the parent sees the
 * committed approval.resolved event.
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
  const [resolving, setResolving] = useState<{ approved: boolean } | null>(null)
  const [remaining, setRemaining] = useState(GRACE_SECONDS)

  useEffect(() => {
    if (resolving === null) {
      return
    }
    setRemaining(GRACE_SECONDS)
    const interval = setInterval(() => {
      setRemaining((previous) => Math.max(0, previous - 1))
    }, 1000)
    return () => {
      clearInterval(interval)
    }
  }, [resolving])

  const decide = (approved: boolean): void => {
    setResolving({ approved })
    onResolve(approved)
  }

  const undo = (): void => {
    setResolving(null)
    onUndo()
  }

  return (
    <div className="approval-card">
      <p className="approval-what">
        {approval.tool} {compactInput(approval.input)}
      </p>
      {resolving === null ? (
        <div className="approval-actions">
          <button type="button" className="approve-button" onClick={() => decide(true)}>
            Approve
          </button>
          <button type="button" className="deny-button" onClick={() => decide(false)}>
            Deny
          </button>
        </div>
      ) : (
        <div className="approval-actions approval-resolving">
          <span className={resolving.approved ? 'resolving-approved' : 'resolving-denied'}>
            {resolving.approved ? 'Approving' : 'Denying'} · {remaining}s
          </span>
          <button type="button" className="undo-button" onClick={undo}>
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
