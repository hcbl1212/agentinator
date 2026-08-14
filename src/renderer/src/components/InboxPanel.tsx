import { useInbox } from '../state/inbox'
import { useSelection } from '../state/selection'
import { useSessions } from '../state/sessions'

/**
 * The attention triage panel: every agent blocked on you — a pending approval
 * or an unanswered question — in one list. Click an item to jump to that agent
 * (the stream and composer follow the selection, where you act on it).
 */
export function InboxPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { items } = useInbox()
  const { sessions } = useSessions()
  const { select } = useSelection()

  const titleOf = (sessionId: string): string =>
    sessions.find((session) => session.id === sessionId)?.title ?? 'An agent'

  const jump = (sessionId: string): void => {
    select({ kind: 'session', id: sessionId })
    onClose()
  }

  return (
    <div className="inbox-panel" role="dialog" aria-label="Attention inbox">
      <div className="budget-panel-head">
        <span className="pane-label">Needs you</span>
        <button
          type="button"
          className="budget-panel-close"
          aria-label="Close inbox"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {items.length === 0 ? (
        <p className="budget-panel-note">
          Nothing needs you right now. Approvals and agent questions land here.
        </p>
      ) : (
        <ul className="inbox-list">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="inbox-item"
                onClick={() => jump(item.sessionId)}
                aria-label={`Go to ${titleOf(item.sessionId)}`}
              >
                <span className={`inbox-kind is-${item.kind}`}>
                  {item.kind === 'approval' ? 'Approve' : 'Answer'}
                </span>
                <span className="inbox-text">
                  <span className="inbox-agent">{titleOf(item.sessionId)}</span>
                  <span className="inbox-detail">
                    {item.kind === 'approval' ? `wants to run ${item.detail}` : item.detail}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
