import { useEffect, useState } from 'react'

/**
 * The slim fleet rail. Today it tracks whether an agent is live (a running
 * dot) so the conversation column can stay a pure dialogue surface; it grows
 * into the per-agent switcher when multiple sessions run at once.
 */
export function AgentRail(): React.JSX.Element {
  const [running, setRunning] = useState(0)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    return bridge.events.onAppended((event) => {
      if (event.type === 'session.started') {
        setRunning((previous) => previous + 1)
      } else if (event.type === 'session.ended') {
        setRunning((previous) => Math.max(0, previous - 1))
      }
    })
  }, [])

  return (
    <aside className="pane rail" aria-label="Agents">
      <h2 className="pane-label rail-label">Agents</h2>
      {running === 0 ? (
        <p className="rail-empty" aria-label="No active agents">
          —
        </p>
      ) : (
        <div className="rail-agent" aria-label={`${running} active`}>
          <span className="status-dot running" aria-hidden="true" />
          <span className="rail-count">{running}</span>
        </div>
      )}
    </aside>
  )
}
