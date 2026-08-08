import { ComposerDock } from './ComposerDock'
import { Timeline } from './Timeline'

/**
 * The unified conversation ∪ timeline. Your messages and the agent's events
 * are the same log, so the Timeline renders the whole stream and the composer
 * docks at its foot — you read the conversation and steer it in one place.
 * Diffs stay a separate view (the Inspector), never inline here.
 */
export function Stream(): React.JSX.Element {
  return (
    <section className="stream" aria-label="Conversation">
      <Timeline />
      <ComposerDock />
    </section>
  )
}
