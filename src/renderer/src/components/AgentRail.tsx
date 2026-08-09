import { useSelection } from '../state/selection'
import { useSessions } from '../state/sessions'

/** A vendor id → display label. Until model selection lands this is the
 * provider name; it becomes "Claude · <model>" once a model is chosen. */
function vendorLabel(providerId: string): string {
  return providerId.charAt(0).toUpperCase() + providerId.slice(1)
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
            <li key={session.id}>
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
                </span>
                {session.providerId !== undefined && (
                  <span className="rail-agent-vendor">{vendorLabel(session.providerId)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
