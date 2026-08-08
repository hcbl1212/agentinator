import { useState } from 'react'

export function Roster(): React.JSX.Element {
  const bridge = window.agentinator
  const [dispatched, setDispatched] = useState(false)

  return (
    <aside className="pane roster" aria-label="Agent roster">
      <h2 className="pane-label">Agents</h2>
      <p className="empty-state">No agents yet. Run the demo to watch events flow into the log.</p>
      {bridge !== undefined && (
        <button
          type="button"
          className="demo-button"
          onClick={() => {
            setDispatched(true)
            void bridge.agent.startDemo()
          }}
        >
          ▶ Run demo agent
        </button>
      )}
      {dispatched && (
        <p className="empty-state">Demo dispatched — watch the log count in the status bar.</p>
      )}
    </aside>
  )
}
