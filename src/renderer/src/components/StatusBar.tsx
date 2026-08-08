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
    return () => {
      cancelled = true
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
