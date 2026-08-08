import { AgentRail } from './components/AgentRail'
import { Conversation } from './components/Conversation'
import { StatusBar } from './components/StatusBar'
import { Workspace } from './components/Workspace'
import { Preview } from './components/Preview'
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
        <Conversation />
        <Workspace />
        <Preview />
      </div>
      <StatusBar />
    </div>
  )
}
