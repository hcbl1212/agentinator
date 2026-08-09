import { useSelection } from '../state/selection'
import { ComposerDock } from './ComposerDock'
import { Timeline } from './Timeline'

/**
 * The unified conversation ∪ timeline. Your messages and the agent's events
 * are the same log, so the Timeline renders the whole stream and the composer
 * docks at its foot — you read the conversation and steer it in one place.
 * Scoped to the highlighted agent; diffs stay a separate view (the Inspector).
 */
export function Stream(): React.JSX.Element {
  const { selection } = useSelection()
  const sessionId = selection?.kind === 'session' ? selection.id : null

  return (
    <section className="stream" aria-label="Conversation">
      <Timeline sessionId={sessionId} />
      <ComposerDock />
    </section>
  )
}
