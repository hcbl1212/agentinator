import { CapacityBanner } from './components/CapacityBanner'
import { Panes } from './components/Panes'
import { StatusBar } from './components/StatusBar'
import { QueueProvider } from './state/queue'
import { SelectionProvider } from './state/selection'
import { SessionsProvider } from './state/sessions'

export function App(): React.JSX.Element {
  return (
    <SelectionProvider>
      <SessionsProvider>
        <QueueProvider>
          <AppShell />
        </QueueProvider>
      </SessionsProvider>
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
      <CapacityBanner />
      <Panes />
      <StatusBar />
    </div>
  )
}
