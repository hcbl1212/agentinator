import { useEffect, useState } from 'react'

import type { EventPayloads } from '../../../shared/events'

export function StatusBar(): React.JSX.Element {
  const [eventCount, setEventCount] = useState<number | null>(null)
  const [tokens, setTokens] = useState({ input: 0, cacheRead: 0 })

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.count().then((count) => {
      if (!cancelled) {
        setEventCount(count)
      }
    })
    // seq is the row count in an append-only log that starts at 1 — a live
    // append can update the count without a round trip.
    const unsubscribe = bridge.events.onAppended((event) => {
      setEventCount(event.seq)
      if (event.type === 'cost.usage') {
        const payload = event.payload as EventPayloads['cost.usage']
        setTokens((previous) => ({
          input: previous.input + payload.inputTokens,
          cacheRead: previous.cacheRead + payload.cacheReadInputTokens,
        }))
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const tokensSeen = tokens.input + tokens.cacheRead
  const cacheHealth =
    tokensSeen === 0 ? 'cache —' : `cache ${Math.round((tokens.cacheRead / tokensSeen) * 100)}%`

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span>0 agents</span>
      <span>$0.00 today</span>
      <span>{eventCount === null ? 'log —' : `log ${eventCount} events`}</span>
      <span title="Share of input tokens served from the prompt cache this session">
        {cacheHealth}
      </span>
      <span className="statusbar-right">v0.1.0</span>
    </footer>
  )
}
