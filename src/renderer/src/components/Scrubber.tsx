import { useScrub } from '../state/scrub'

/**
 * The global time bar: drag to rewind every scrub-aware view (the transcript
 * today; the preview and plan states as they come online) to a point in the
 * append-only log. "Live" resumes following new events. Hidden until the log
 * has something to scrub.
 */
export function Scrubber(): React.JSX.Element | null {
  const { seq, max, setSeq } = useScrub()

  if (max === 0) {
    return null
  }

  const live = seq === null
  return (
    <div className="scrubber" role="group" aria-label="Timeline scrubber">
      <span className="scrubber-label">Time</span>
      <input
        type="range"
        className="scrubber-range"
        min={1}
        max={max}
        value={seq ?? max}
        onChange={(event) => setSeq(Number(event.target.value))}
        aria-label="Scrub timeline"
      />
      <span className="scrubber-pos">{live ? 'live' : `#${seq} / ${max}`}</span>
      <button type="button" className="scrubber-live" disabled={live} onClick={() => setSeq(null)}>
        Live
      </button>
    </div>
  )
}
