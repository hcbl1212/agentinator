import { useEffect, useState } from 'react'

import { usePlans } from '../state/plans'
import { useScrub } from '../state/scrub'
import { useSelection } from '../state/selection'
import { ComposerDock } from './ComposerDock'
import { PlanCanvas } from './PlanCanvas'
import { ReviewWorkbench } from './ReviewWorkbench'
import { Timeline } from './Timeline'

/**
 * The unified conversation ∪ timeline, scoped to the highlighted agent: your
 * messages and the agent's events are the same log, so the Timeline renders
 * the whole stream and the composer docks at its foot. With no agent selected
 * the slot shows the plan DAG canvas instead (the newest plan, or the one
 * picked in the Planner rail); selecting a pipeline swaps in its review
 * workbench. The plain empty state only remains when there's no plan either.
 */
export function Stream(): React.JSX.Element {
  const { selection, select, clear } = useSelection()
  const { plans } = usePlans()
  const { seq } = useScrub()
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [lastSession, setLastSession] = useState<string | null>(null)
  const sessionId = selection?.kind === 'session' ? selection.id : null
  const reviewingId = selection?.kind === 'pipeline' ? selection.id : null
  const showCanvas = sessionId === null && reviewingId === null && plans.length > 0

  // Remember the agent last watched, so the Timeline half of the toggle has
  // somewhere to go after Plan clears the selection.
  useEffect(() => {
    if (sessionId !== null) {
      setLastSession(sessionId)
    }
  }, [sessionId])
  const timelineTarget = sessionId ?? lastSession

  return (
    <section className="stream" aria-label="Conversation">
      {/* Both views exist → an explicit toggle, so the DAG is never a dead
          end you can't get back to (or away from). */}
      {plans.length > 0 && timelineTarget !== null && (
        <div className="workspace-tabs stream-view-toggle" role="tablist" aria-label="Stream view">
          <button
            type="button"
            role="tab"
            aria-selected={sessionId !== null}
            className={`workspace-tab${sessionId !== null ? ' is-active' : ''}`}
            onClick={() => select({ kind: 'session', id: timelineTarget })}
          >
            Timeline
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sessionId === null}
            className={`workspace-tab${sessionId === null ? ' is-active' : ''}`}
            onClick={() => clear()}
          >
            Plan
          </button>
        </div>
      )}
      {sessionId !== null ? (
        <Timeline sessionId={sessionId} scrubSeq={seq} />
      ) : reviewingId !== null ? (
        <ReviewWorkbench pipelineId={reviewingId} />
      ) : plans.length > 0 ? (
        <PlanCanvas onInspect={setInspecting} />
      ) : (
        <section className="pane timeline" aria-label="Activity timeline">
          <p className="empty-state">Select an agent, or start a task below.</p>
        </section>
      )}
      {/* One text surface at a time: the composer stands down while a task's
          detail card (its editable brief) or the review workbench — which
          carries its own revise input — has the floor. */}
      {!(showCanvas && inspecting !== null) && reviewingId === null && <ComposerDock />}
    </section>
  )
}
