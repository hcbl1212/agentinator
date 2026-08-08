export function StatusBar(): React.JSX.Element {
  return (
    <footer className="statusbar" aria-label="Status bar">
      <span>0 agents</span>
      <span>$0.00 today</span>
      <span className="statusbar-right">v0.1.0</span>
    </footer>
  )
}
