import { AgentRail } from './components/AgentRail'
import { Inspector } from './components/Inspector'
import { StatusBar } from './components/StatusBar'
import { Stream } from './components/Stream'
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
      <div className="panes">
        <AgentRail />
        <Stream />
        <Inspector />
      </div>
      <StatusBar />
    </div>
  )
}
