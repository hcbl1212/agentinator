import { useEffect, useRef, useState } from 'react'

import type { StoredEvent } from '../../../shared/events'
import { describeEvent, mergeBySeq } from '../timeline/timelineFormat'

export function Timeline(): React.JSX.Element {
  const [events, setEvents] = useState<StoredEvent[]>([])
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.list().then((list) => {
      if (!cancelled) {
        setEvents((previous) => mergeBySeq(list, previous))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setEvents((previous) => mergeBySeq(previous, [event]))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const end = endRef.current
    // jsdom has no scrollIntoView; the guard keeps tests honest.
    if (end !== null && typeof end.scrollIntoView === 'function') {
      end.scrollIntoView({ block: 'end' })
    }
  }, [events])

  return (
    <section className="pane timeline" aria-label="Activity timeline">
      <h2 className="pane-label">Timeline</h2>
      {events.length === 0 ? (
        <p className="empty-state">
          Agent activity will stream here — tool calls, edits, and tests.
        </p>
      ) : (
        <ol className="timeline-list">
          {events.map((event) => {
            const line = describeEvent(event)
            return (
              <li key={event.seq} className={`timeline-line tone-${line.tone}`}>
                <span className="timeline-marker" aria-hidden="true">
                  {line.marker}
                </span>
                <span className="timeline-text">{line.text}</span>
              </li>
            )
          })}
        </ol>
      )}
      <div ref={endRef} />
    </section>
  )
}
