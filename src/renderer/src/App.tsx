import { Roster } from './components/Roster'
import { StatusBar } from './components/StatusBar'
import { Timeline } from './components/Timeline'
import { Preview } from './components/Preview'

export function App(): React.JSX.Element {
  return (
    <div className="cockpit">
      <header className="titlebar">
        <span className="titlebar-name">Agentinator</span>
        <span className="titlebar-context">no workspace open</span>
      </header>
      <div className="panes">
        <Roster />
        <Timeline />
        <Preview />
      </div>
      <StatusBar />
    </div>
  )
}
