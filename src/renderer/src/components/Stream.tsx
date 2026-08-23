import { useScrub } from '../state/scrub'
import { useSelection } from '../state/selection'
import { ComposerDock } from './ComposerDock'
import { Timeline } from './Timeline'

/**
 * The unified conversation ∪ timeline, scoped to the highlighted agent: your
 * messages and the agent's events are the same log, so the Timeline renders
 * the whole stream and the composer docks at its foot. With no agent selected
 * the stream is empty — pick one in the rail or start a task below.
 */
export function Stream(): React.JSX.Element {
  const { selection } = useSelection()
  const { seq } = useScrub()
  const sessionId = selection?.kind === 'session' ? selection.id : null

  return (
    <section className="stream" aria-label="Conversation">
      {sessionId === null ? (
        <section className="pane timeline" aria-label="Activity timeline">
          <p className="empty-state">Select an agent, or start a task below.</p>
        </section>
      ) : (
        <Timeline sessionId={sessionId} scrubSeq={seq} />
      )}
      <ComposerDock />
    </section>
  )
}
