import { useEffect, useRef, useState } from 'react'

import type { StoredEvent } from '../../../shared/events'
import { describeEvent, mergeBySeq } from '../timeline/timelineFormat'

/**
 * Renders a bounded window over the append-only log: the newest `pageSize`
 * events plus live appends, with scrollback pages fetched on demand. The
 * full log stays in SQLite — never in renderer memory.
 */
export function Timeline({ pageSize = 200 }: { pageSize?: number }): React.JSX.Element {
  const [events, setEvents] = useState<StoredEvent[]>([])
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.tail(pageSize).then((page) => {
      if (!cancelled) {
        setEvents((previous) => mergeBySeq(page, previous))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setEvents((previous) => mergeBySeq(previous, [event]))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [pageSize])

  useEffect(() => {
    const end = endRef.current
    // jsdom has no scrollIntoView; the guard keeps tests honest.
    if (end !== null && typeof end.scrollIntoView === 'function') {
      end.scrollIntoView({ block: 'end' })
    }
  }, [events])

  const earliestSeq = events[0]?.seq
  const hasEarlier = earliestSeq !== undefined && earliestSeq > 1

  const loadEarlier = (): void => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    void bridge.events.tail(pageSize, earliestSeq).then((page) => {
      setEvents((previous) => mergeBySeq(page, previous))
    })
  }

  return (
    <section className="pane timeline" aria-label="Activity timeline">
      <h2 className="pane-label">Timeline</h2>
      {hasEarlier && (
        <button type="button" className="load-earlier" onClick={loadEarlier}>
          ↑ Load earlier events
        </button>
      )}
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
