import { useEffect, useRef, useState } from 'react'

import type { StoredEvent } from '../../../shared/events'
import { isConversationEvent } from '../conversation/conversationLog'
import { describeEvent, mergeBySeq } from '../timeline/timelineFormat'

/**
 * The terminal-style transcript: a read-only console of the dialogue rendered
 * from the append-only log. Same normalized events as the Timeline, but
 * filtered to the conversation subset and rendered as a monospace stream you
 * read top to bottom. Autoscroll is pinned-to-bottom; reading history never
 * gets yanked by a live append, and "↓ Latest" re-pins.
 */
export function ConversationLog({ pageSize = 200 }: { pageSize?: number }): React.JSX.Element {
  const [events, setEvents] = useState<StoredEvent[]>([])
  const [pinned, setPinned] = useState(true)
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

  const visible = events.filter(isConversationEvent)

  const scrollToEnd = (): void => {
    const end = endRef.current
    // jsdom has no scrollIntoView; the guard keeps tests honest.
    if (end !== null && typeof end.scrollIntoView === 'function') {
      end.scrollIntoView({ block: 'end' })
    }
  }

  useEffect(() => {
    if (pinned) {
      scrollToEnd()
    }
  }, [visible.length, pinned])

  const handleScroll = (scrollEvent: React.UIEvent<HTMLElement>): void => {
    const pane = scrollEvent.currentTarget
    setPinned(pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40)
  }

  return (
    <div className="convo-log" onScroll={handleScroll}>
      {visible.length === 0 ? (
        <p className="empty-state">Your conversation with the agent appears here.</p>
      ) : (
        <ol className="convo-lines">
          {visible.map((event) => {
            const line = describeEvent(event)
            return (
              <li key={event.seq} className={`convo-line tone-${line.tone}`}>
                <span className="convo-marker" aria-hidden="true">
                  {line.marker === '' ? '·' : line.marker}
                </span>
                <span className="convo-text">{line.text}</span>
              </li>
            )
          })}
        </ol>
      )}
      {!pinned && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            setPinned(true)
            scrollToEnd()
          }}
        >
          ↓ Latest
        </button>
      )}
      <div ref={endRef} />
    </div>
  )
}
