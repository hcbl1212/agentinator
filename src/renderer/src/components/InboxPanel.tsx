import { blockageOf } from '../state/blockage'
import { useInbox } from '../state/inbox'
import { usePipelines } from '../state/pipelines'
import { usePlans } from '../state/plans'
import { useSelection } from '../state/selection'
import { useSessions } from '../state/sessions'

/**
 * The attention triage panel: every agent blocked on you — a pending approval
 * or an unanswered question — in one list, ranked by what your delay costs.
 * Items whose agent works a plan task are weighted by that task's downstream
 * blockage (how many tasks wait on it, transitively) — critical-path items
 * first, leaf-task noise last, everything else in arrival order. Click an item
 * to jump to that agent (the stream and composer follow the selection).
 */
export function InboxPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { items } = useInbox()
  const { sessions } = useSessions()
  const { plans } = usePlans()
  const { pipelines } = usePipelines()
  const { select } = useSelection()

  const titleOf = (sessionId: string): string =>
    sessions.find((session) => session.id === sessionId)?.title ?? 'An agent'

  // Rank by DAG weight; the sort is stable, so equal weights keep arrival order.
  const weighted = items
    .map((item) => ({ item, blocks: blockageOf(item.sessionId, plans, pipelines) }))
    .sort((a, b) => b.blocks - a.blocks)

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
          {weighted.map(({ item, blocks }) => (
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
                {blocks > 0 && (
                  <span
                    className="inbox-blocks"
                    title={`${blocks} downstream task(s) wait on this`}
                  >
                    blocks {blocks}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
