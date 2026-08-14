import { useInbox } from '../state/inbox'
import { useSelection } from '../state/selection'
import { useSessions } from '../state/sessions'
import type { SessionInfo } from '../state/sessions'

/** The per-agent vendor/model label, e.g. "Claude" or "Claude · opus-4-8"
 * (the vendor prefix is stripped from the model to avoid repeating it). */
function vendorLabel(providerId: string, model?: string): string {
  const vendor = providerId.charAt(0).toUpperCase() + providerId.slice(1)
  if (model === undefined) {
    return vendor
  }
  const short = model.startsWith(`${providerId}-`) ? model.slice(providerId.length + 1) : model
  return `${vendor} · ${short}`
}

/** The roster groups, most-urgent first. */
const GROUPS = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'running', label: 'Running' },
  { key: 'idle', label: 'Idle' },
  { key: 'failed', label: 'Failed' },
] as const
type GroupKey = (typeof GROUPS)[number]['key']

/** Which roster group an agent belongs in. Waiting on you wins over its raw
 * status — a running agent blocked on an approval belongs under "Needs you". */
export function groupFor(session: SessionInfo, needsYou: boolean): GroupKey {
  if (needsYou) {
    return 'needs-you'
  }
  if (session.status === 'error') {
    return 'failed'
  }
  return session.status === 'running' ? 'running' : 'idle'
}

/**
 * The fleet rail: live agents grouped by what they need — Needs you (blocked on
 * an approval or question) first, then Running, Idle, and Failed. Clicking one
 * highlights it, and the stream/inspector follow. "New agent" clears the
 * selection so the composer starts a fresh task. The selection is sticky — it
 * stays on the highlighted agent even if that agent ends, so its final state
 * (including a failure) stays visible in the stream.
 */
export function AgentRail(): React.JSX.Element {
  const { sessions } = useSessions()
  const { items } = useInbox()
  const { selection, select, clear } = useSelection()
  const selectedId = selection?.kind === 'session' ? selection.id : null
  const needsYou = new Set(items.map((item) => item.sessionId))

  // Remove an agent from the fleet: stop it if it's live, drop it from the rail,
  // and let go of the selection if it was the one showing.
  const dismiss = (id: string): void => {
    void window.agentinator?.agent.dismiss(id)
    if (id === selectedId) {
      clear()
    }
  }

  // Toggle this agent between its provider's stored API key (metered) and its
  // subscription login — the deliberate, on-demand version of what a plan limit
  // offers, and the way back.
  const toggleCredential = (session: SessionInfo): void => {
    const agent = window.agentinator?.agent
    if (session.metered === true) {
      void agent?.switchToSubscription(session.id)
    } else {
      void agent?.switchToApiKey(session.id)
    }
  }

  const row = (session: SessionInfo): React.JSX.Element => (
    <li key={session.id} className="rail-row">
      <button
        type="button"
        className={`rail-agent${session.id === selectedId ? ' is-selected' : ''}`}
        aria-pressed={session.id === selectedId}
        title={session.title}
        onClick={() => select({ kind: 'session', id: session.id })}
      >
        <span className="rail-agent-head">
          <span className={`status-dot ${session.status}`} aria-hidden="true" />
          <span className="rail-agent-title">{session.title}</span>
          {session.costUsd > 0 && (
            <span className="rail-agent-cost">${session.costUsd.toFixed(2)}</span>
          )}
        </span>
        {session.providerId !== undefined && (
          <span className="rail-agent-vendor">
            <span>{vendorLabel(session.providerId, session.model)}</span>
            <span className={`rail-agent-mode${session.metered === true ? ' is-metered' : ''}`}>
              {session.metered === true ? 'API key' : 'plan'}
            </span>
          </span>
        )}
        {session.branch !== undefined && (
          <span className="rail-agent-branch" title={`Isolated on ${session.branch}`}>
            ⑂ {session.branch}
          </span>
        )}
      </button>
      <span className="rail-agent-actions">
        <button
          type="button"
          className="rail-agent-action"
          aria-label={
            session.metered === true
              ? `Switch ${session.title} to subscription`
              : `Switch ${session.title} to API key`
          }
          title={session.metered === true ? 'Switch to subscription' : 'Switch to API key'}
          onClick={() => toggleCredential(session)}
        >
          ⚿
        </button>
        <button
          type="button"
          className="rail-agent-action"
          aria-label={`Remove ${session.title}`}
          title="Remove agent"
          onClick={() => dismiss(session.id)}
        >
          ✕
        </button>
      </span>
    </li>
  )

  const groups = GROUPS.map((group) => ({
    ...group,
    rows: sessions.filter((session) => groupFor(session, needsYou.has(session.id)) === group.key),
  })).filter((group) => group.rows.length > 0)

  return (
    <aside className="pane rail" aria-label="Agents">
      <div className="rail-head">
        <h2 className="pane-label">Agents</h2>
        <button type="button" className="rail-new" aria-label="New agent" onClick={() => clear()}>
          ＋
        </button>
      </div>
      {sessions.length === 0 ? (
        <p className="rail-empty" aria-label="No active agents">
          No agents yet.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="rail-group">
            <span className={`rail-group-label is-${group.key}`}>
              <span className="rail-group-name">{group.label}</span>
              <span className="rail-group-count">{group.rows.length}</span>
            </span>
            <ul className="rail-list">{group.rows.map(row)}</ul>
          </div>
        ))
      )}
    </aside>
  )
}
