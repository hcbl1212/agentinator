import { useState } from 'react'

import { useSelection } from '../state/selection'
import { Checkpoints } from './Checkpoints'
import { DiffView } from './DiffView'
import { Preview } from './Preview'

type Tab = 'diff' | 'preview' | 'checkpoints'

const TABS: { key: Tab; label: string }[] = [
  { key: 'diff', label: 'Diff' },
  { key: 'preview', label: 'Preview' },
  { key: 'checkpoints', label: 'Checkpoints' },
]

/**
 * The right pane: a tabbed inspector over the selected agent's output — the
 * cumulative Diff, the live app Preview, and its worktree Checkpoints. Kept
 * separate from the stream so reviewing changes is its own mode, not lines
 * scrolling past. (A selected plan takes over the CENTER pane with its canvas —
 * the graph needs the width, not a side tab.)
 */
export function Inspector(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('diff')
  const { selection } = useSelection()
  const sessionId = selection?.kind === 'session' ? selection.id : null

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
      </div>
    </section>
  )
}
