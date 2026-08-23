import { useState } from 'react'

import { usePlans } from '../state/plans'
import { useScrub } from '../state/scrub'
import { useSelection } from '../state/selection'
import { ComposerDock } from './ComposerDock'
import { PlanCanvas } from './PlanCanvas'
import { Timeline } from './Timeline'

/**
 * The unified conversation ∪ timeline, scoped to the highlighted agent: your
 * messages and the agent's events are the same log, so the Timeline renders
 * the whole stream and the composer docks at its foot. With no agent selected
 * the slot shows the plan DAG canvas instead (the newest plan, or the one
 * picked in the Planner rail) — the graph gets the width it needs, and the
 * plain empty state only remains when there's no plan either.
 */
export function Stream(): React.JSX.Element {
  const { selection } = useSelection()
  const { plans } = usePlans()
  const { seq } = useScrub()
  const [inspecting, setInspecting] = useState<string | null>(null)
  const sessionId = selection?.kind === 'session' ? selection.id : null
  const showCanvas = sessionId === null && plans.length > 0

  return (
    <section className="stream" aria-label="Conversation">
      {sessionId !== null ? (
        <Timeline sessionId={sessionId} scrubSeq={seq} />
      ) : plans.length > 0 ? (
        <PlanCanvas onInspect={setInspecting} />
      ) : (
        <section className="pane timeline" aria-label="Activity timeline">
          <p className="empty-state">Select an agent, or start a task below.</p>
        </section>
      )}
      {/* One text surface at a time: while a task's detail card (its editable
          brief) is open on the canvas, the composer stands down. */}
      {!(showCanvas && inspecting !== null) && <ComposerDock />}
    </section>
  )
}
