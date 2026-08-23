import { CapacityBanner } from './components/CapacityBanner'
import { Panes } from './components/Panes'
import { Scrubber } from './components/Scrubber'
import { StatusBar } from './components/StatusBar'
import { AgentTypesProvider } from './state/agentTypes'
import { InboxProvider } from './state/inbox'
import { PipelineProvider } from './state/pipelines'
import { PlanProvider } from './state/plans'
import { QueueProvider } from './state/queue'
import { ScrubProvider } from './state/scrub'
import { SelectionProvider } from './state/selection'
import { SessionsProvider } from './state/sessions'
import { SkillsProvider } from './state/skills'

export function App(): React.JSX.Element {
  return (
    <SelectionProvider>
      <SessionsProvider>
        <QueueProvider>
          <PipelineProvider>
            <PlanProvider>
              <AgentTypesProvider>
                <SkillsProvider>
                  <ScrubProvider>
                    <InboxProvider>
                      <AppShell />
                    </InboxProvider>
                  </ScrubProvider>
                </SkillsProvider>
              </AgentTypesProvider>
            </PlanProvider>
          </PipelineProvider>
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
      <Scrubber />
      <StatusBar />
    </div>
  )
}
