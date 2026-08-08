export function Timeline(): React.JSX.Element {
  return (
    <section className="pane timeline" aria-label="Activity timeline">
      <h2 className="pane-label">Timeline</h2>
      <p className="empty-state">Agent activity will stream here — tool calls, edits, and tests.</p>
    </section>
  )
}
