export function Preview(): React.JSX.Element {
  return (
    <section className="pane preview" aria-label="App preview">
      <h2 className="pane-label">Preview</h2>
      <p className="empty-state">The target app renders here once a workspace has services.</p>
    </section>
  )
}
