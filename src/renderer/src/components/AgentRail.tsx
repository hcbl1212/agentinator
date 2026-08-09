import { useSelection } from '../state/selection'
import { useSessions } from '../state/sessions'

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

/**
 * The fleet rail: every live agent as a selectable row. Clicking one highlights
 * it, and the stream/inspector follow the selection. "New agent" clears the
 * selection so the composer starts a fresh task. The selection is sticky — it
 * stays on the highlighted agent even if that agent ends, so its final state
 * (including a failure) stays visible in the stream.
 */
export function AgentRail(): React.JSX.Element {
  const { sessions } = useSessions()
  const { selection, select, clear } = useSelection()
  const selectedId = selection?.kind === 'session' ? selection.id : null

  // Remove an agent from the fleet: stop it if it's live, drop it from the rail,
  // and let go of the selection if it was the one showing.
  const dismiss = (id: string): void => {
    void window.agentinator?.agent.dismiss(id)
    if (id === selectedId) {
      clear()
    }
  }

  // Reconnect this agent onto its provider's stored API key (metered) — the
  // deliberate, on-demand version of what a plan limit offers.
  const switchToApiKey = (id: string): void => {
    void window.agentinator?.agent.switchToApiKey(id)
  }

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
        <ul className="rail-list">
          {sessions.map((session) => (
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
                    {vendorLabel(session.providerId, session.model)}
                  </span>
                )}
              </button>
              <span className="rail-agent-actions">
                <button
                  type="button"
                  className="rail-agent-action"
                  aria-label={`Switch ${session.title} to API key`}
                  title="Switch to API key"
                  onClick={() => switchToApiKey(session.id)}
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
          ))}
        </ul>
      )}
    </aside>
  )
}
