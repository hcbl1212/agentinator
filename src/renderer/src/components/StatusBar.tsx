import { useEffect, useState } from 'react'

export function StatusBar(): React.JSX.Element {
  const [eventCount, setEventCount] = useState<number | null>(null)

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
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span>0 agents</span>
      <span>$0.00 today</span>
      <span>{eventCount === null ? 'log —' : `log ${eventCount} events`}</span>
      <span className="statusbar-right">v0.1.0</span>
    </footer>
  )
}
