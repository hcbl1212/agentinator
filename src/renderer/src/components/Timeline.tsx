import { useEffect, useRef, useState } from 'react'

import type { StoredEvent } from '../../../shared/events'
import { describeEvent, matchesQuery, mergeBySeq } from '../timeline/timelineFormat'

/**
 * Renders a bounded window over the append-only log: the newest `pageSize`
 * events plus live appends, with scrollback pages fetched on demand. The
 * full log stays in SQLite — never in renderer memory.
 *
 * Search queries the whole log store-side; Clear empties the VIEW only
 * (events are immutable — Load earlier brings history back).
 */
export function Timeline({ pageSize = 200 }: { pageSize?: number }): React.JSX.Element {
  const [windowEvents, setWindowEvents] = useState<StoredEvent[]>([])
  const [searchResults, setSearchResults] = useState<StoredEvent[]>([])
  const [query, setQuery] = useState('')
  const [floorSeq, setFloorSeq] = useState(0)
  const queryRef = useRef('')
  queryRef.current = query
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.tail(pageSize).then((page) => {
      if (!cancelled) {
        setWindowEvents((previous) => mergeBySeq(page, previous))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setWindowEvents((previous) => mergeBySeq(previous, [event]))
      if (queryRef.current !== '' && matchesQuery(event, queryRef.current)) {
        setSearchResults((previous) => mergeBySeq(previous, [event]))
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [pageSize])

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined || query === '') {
      setSearchResults([])
      return
    }
    let cancelled = false
    void bridge.events.search(query, pageSize).then((results) => {
      if (!cancelled) {
        setSearchResults(results)
      }
    })
    return () => {
      cancelled = true
    }
  }, [query, pageSize])

  const searching = query !== ''
  const visible = searching ? searchResults : windowEvents

  useEffect(() => {
    const end = endRef.current
    // jsdom has no scrollIntoView; the guard keeps tests honest.
    if (end !== null && typeof end.scrollIntoView === 'function') {
      end.scrollIntoView({ block: 'end' })
    }
  }, [visible])

  const earliestCursor = windowEvents[0]?.seq ?? floorSeq + 1
  const hasEarlier = !searching && earliestCursor > 1

  const loadEarlier = (): void => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    void bridge.events.tail(pageSize, earliestCursor).then((page) => {
      setWindowEvents((previous) => mergeBySeq(page, previous))
    })
  }

  const clearView = (): void => {
    // Only reachable from the Clear button, which renders only when the
    // window is non-empty — the last element is always present.
    setFloorSeq(windowEvents[windowEvents.length - 1].seq)
    setWindowEvents([])
  }

  const emptyState = (): string => {
    if (searching) {
      return `No matches for “${query}” in the log.`
    }
    if (floorSeq > 0) {
      return 'View cleared — new activity appears here; ↑ restores history.'
    }
    return 'Agent activity will stream here — tool calls, edits, and tests.'
  }

  return (
    <section className="pane timeline" aria-label="Activity timeline">
      <div className="timeline-toolbar">
        <h2 className="pane-label">Timeline</h2>
        <input
          type="search"
          className="timeline-search"
          placeholder="Search log…"
          aria-label="Search events"
          value={query}
          onChange={(changed) => setQuery(changed.target.value)}
        />
        {!searching && visible.length > 0 && (
          <button
            type="button"
            className="timeline-clear"
            title="Clears the view only — events stay in the log"
            onClick={clearView}
          >
            Clear
          </button>
        )}
      </div>
      {hasEarlier && (
        <button type="button" className="load-earlier" onClick={loadEarlier}>
          ↑ Load earlier events
        </button>
      )}
      {visible.length === 0 ? (
        <p className="empty-state">{emptyState()}</p>
      ) : (
        <ol className="timeline-list">
          {visible.map((event) => {
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
