import { useEffect, useRef, useState } from 'react'

import type { EventPayloads } from '../../../shared/events'
import type { AccountLimit, LimitStatus } from '../../../shared/usage'

const WINDOW_LABEL: Record<string, string> = {
  five_hour: 'session (5-hour)',
  seven_day: 'weekly',
  seven_day_opus: 'weekly · Opus',
  seven_day_sonnet: 'weekly · Sonnet',
  overage: 'overage',
}

function resetText(resetsAtMs: number | null): string {
  if (resetsAtMs === null) {
    return ''
  }
  const at = new Date(resetsAtMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return ` — resets ${at}`
}

/**
 * Account-wide capacity notice. When the provider pushes a rate-limit signal
 * (approaching or hit), this surfaces a banner with the window and reset time.
 * Dismiss hides it until the *status* changes, so a stream of identical signals
 * doesn't nag. Overage / switch-credential actions arrive in the next slice.
 */
export function CapacityBanner(): React.JSX.Element | null {
  const [limit, setLimit] = useState<AccountLimit | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const lastStatus = useRef<LimitStatus | null>(null)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    return bridge.events.onAppended((event) => {
      if (event.type === 'account.limit') {
        const next = event.payload as EventPayloads['account.limit']
        if (next.status !== lastStatus.current) {
          setDismissed(false)
        }
        lastStatus.current = next.status
        setLimit(next)
      }
    })
  }, [])

  if (limit === null || limit.status === 'ok' || dismissed) {
    return null
  }
  const rejected = limit.status === 'rejected'
  const windowLabel = limit.window === null ? 'plan' : (WINDOW_LABEL[limit.window] ?? limit.window)
  return (
    <div
      className={`capacity-banner${rejected ? ' is-rejected' : ''}`}
      role="status"
      aria-label="Capacity limit"
    >
      <span className="capacity-text">
        {rejected ? 'Reached' : 'Approaching'} your {windowLabel} limit{resetText(limit.resetsAtMs)}
        .
      </span>
      <button type="button" className="capacity-dismiss" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  )
}
