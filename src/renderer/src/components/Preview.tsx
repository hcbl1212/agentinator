export function Preview({ sessionId }: { sessionId?: string | null }): React.JSX.Element {
  return (
    <section className="pane preview" aria-label="App preview">
      <h2 className="pane-label">Preview</h2>
      <p className="empty-state">
        {sessionId === null || sessionId === undefined
          ? 'Select an agent to preview its app.'
          : 'The target app renders here once a workspace has services.'}
      </p>
    </section>
  )
}
