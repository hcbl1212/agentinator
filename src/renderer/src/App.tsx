import { Panes } from './components/Panes'
import { StatusBar } from './components/StatusBar'
import { SelectionProvider } from './state/selection'

export function App(): React.JSX.Element {
  return (
    <SelectionProvider>
      <AppShell />
    </SelectionProvider>
  )
}

function AppShell(): React.JSX.Element {
  return (
    <div className="cockpit">
      <header className="titlebar">
        <span className="titlebar-name">Agentinator</span>
        <span className="titlebar-context">no workspace open</span>
      </header>
      <Panes />
      <StatusBar />
    </div>
  )
}
