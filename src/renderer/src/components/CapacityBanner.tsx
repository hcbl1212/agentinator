import { useEffect, useRef, useState } from 'react'

import type { EventPayloads } from '../../../shared/events'
import type { LimitStatus } from '../../../shared/usage'

/** Where overage/credits are enabled — the app can't toggle them, but it can
 * hand you straight there. Opened externally by the window's open handler. */
const PLAN_URL = 'https://claude.ai/settings/billing'

const WINDOW_LABEL: Record<string, string> = {
  five_hour: 'session (5-hour)',
  seven_day: 'weekly',
  seven_day_opus: 'weekly · Opus',
  seven_day_sonnet: 'weekly · Sonnet',
  overage: 'overage',
}

type Limit = EventPayloads['account.limit']

function resetText(resetsAtMs: number | null): string {
  if (resetsAtMs === null) {
    return ''
  }
  const at = new Date(resetsAtMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return ` — resets ${at}`
}

/**
 * Account-wide capacity notice. When the provider pushes a rate-limit signal,
 * this surfaces a banner with the window, reset time, and overage state. On a
 * hard limit it offers "Continue on API key" — switching that agent onto its
 * vendor's metered key (entered inline if none is stored, saved to the OS
 * keychain). Dismiss hides it until the status changes so repeats don't nag.
 */
export function CapacityBanner(): React.JSX.Element | null {
  const [limit, setLimit] = useState<Limit | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [entering, setEntering] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const lastStatus = useRef<LimitStatus | null>(null)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    return bridge.events.onAppended((event) => {
      if (event.type === 'account.limit') {
        const next = event.payload as Limit
        if (next.status !== lastStatus.current) {
          setDismissed(false)
          setEntering(false)
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
  const providerId = limit.providerId
  const windowLabel = limit.window === null ? 'plan' : (WINDOW_LABEL[limit.window] ?? limit.window)
  const overageNote = limit.overageInUse
    ? 'Using overage credits.'
    : limit.overageAvailable
      ? 'Overage available — new work continues on credits.'
      : rejected
        ? 'Enable overage, or wait for the reset.'
        : null

  // The switch needs both a bridge and a known vendor; bundle the check so the
  // handlers stay simple.
  const ready = (): {
    bridge: NonNullable<typeof window.agentinator>
    providerId: string
  } | null => {
    const bridge = window.agentinator
    return bridge !== undefined && providerId !== undefined ? { bridge, providerId } : null
  }
  const doSwitch = (bridge: NonNullable<typeof window.agentinator>): void => {
    void bridge.agent.switchToApiKey(limit.sessionId)
    setDismissed(true)
  }
  // Switch if a key is already stored for this vendor; otherwise reveal the
  // inline field to enter one.
  const onContinue = (): void => {
    const r = ready()
    if (r === null) {
      return
    }
    void r.bridge.credentials.has(r.providerId).then((has) => {
      if (has) {
        doSwitch(r.bridge)
      } else {
        setEntering(true)
      }
    })
  }
  const onSaveKey = (): void => {
    const r = ready()
    const key = keyDraft.trim()
    if (r === null || key === '') {
      return
    }
    void r.bridge.credentials.set(r.providerId, key, true).then(() => {
      doSwitch(r.bridge)
    })
  }

  return (
    <div
      className={`capacity-banner${rejected ? ' is-rejected' : ''}`}
      role="status"
      aria-label="Capacity limit"
    >
      <div className="capacity-body">
        <span className="capacity-text">
          {rejected ? 'Reached' : 'Approaching'} your {windowLabel} limit
          {resetText(limit.resetsAtMs)}.
        </span>
        {overageNote !== null && <span className="capacity-overage">{overageNote}</span>}
      </div>
      {entering ? (
        <div className="capacity-actions">
          <input
            type="password"
            className="capacity-key"
            aria-label="API key"
            placeholder="Paste your API key"
            value={keyDraft}
            onChange={(changed) => setKeyDraft(changed.target.value)}
            onKeyDown={(pressed) => {
              if (pressed.key === 'Enter') {
                onSaveKey()
              }
            }}
          />
          <button type="button" className="capacity-switch" onClick={onSaveKey}>
            Save &amp; switch
          </button>
        </div>
      ) : (
        <div className="capacity-actions">
          {rejected && (
            <button type="button" className="capacity-switch" onClick={onContinue}>
              Continue on API key
            </button>
          )}
          <a className="capacity-link" href={PLAN_URL} target="_blank" rel="noreferrer">
            Manage plan
          </a>
          <button type="button" className="capacity-dismiss" onClick={() => setDismissed(true)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
