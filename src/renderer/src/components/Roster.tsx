export function Roster(): React.JSX.Element {
  return (
    <aside className="pane roster" aria-label="Agent roster">
      <h2 className="pane-label">Agents</h2>
      <p className="empty-state">No agents yet. The first one arrives with the provider layer.</p>
    </aside>
  )
}
