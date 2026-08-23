import { useEffect, useState } from 'react'

import { useSelection } from '../state/selection'
import { Checkpoints } from './Checkpoints'
import { DiffView } from './DiffView'
import { PlanCanvas } from './PlanCanvas'
import { Preview } from './Preview'

type Tab = 'diff' | 'preview' | 'checkpoints' | 'plan'

const TABS: { key: Tab; label: string }[] = [
  { key: 'diff', label: 'Diff' },
  { key: 'preview', label: 'Preview' },
  { key: 'checkpoints', label: 'Checkpoints' },
  { key: 'plan', label: 'Plan' },
]

/**
 * The right pane: a tabbed inspector over the selected agent's output — the
 * cumulative Diff, the live app Preview, its worktree Checkpoints, and the
 * editable Plan canvas. Kept separate from the stream so reviewing changes is
 * its own mode, not lines scrolling past.
 */
export function Inspector(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('diff')
  const { selection } = useSelection()
  const sessionId = selection?.kind === 'session' ? selection.id : null

  // Focus-follows: picking a plan (its title in the Planner rail) opens it on
  // the canvas without a second click.
  useEffect(() => {
    if (selection?.kind === 'plan') {
      setTab('plan')
    }
  }, [selection])

  return (
    <section className="workspace inspector" aria-label="Inspector">
      <div className="workspace-tabs" role="tablist" aria-label="Inspector views">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`workspace-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="workspace-body">
        {tab === 'diff' && <DiffView sessionId={sessionId} />}
        {tab === 'preview' && <Preview sessionId={sessionId} />}
        {tab === 'checkpoints' && <Checkpoints sessionId={sessionId} />}
        {tab === 'plan' && <PlanCanvas />}
      </div>
    </section>
  )
}
