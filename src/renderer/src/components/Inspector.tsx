import { useState } from 'react'

import { useSelection } from '../state/selection'
import { DiffView } from './DiffView'
import { Preview } from './Preview'

type Tab = 'diff' | 'preview'

/**
 * The right pane: a tabbed inspector over the selected agent's output — the
 * cumulative Diff and the live app Preview. Kept separate from the stream so
 * reviewing changes is its own mode, not lines scrolling past.
 */
export function Inspector(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('diff')
  const { selection } = useSelection()
  const sessionId = selection?.kind === 'session' ? selection.id : null

  return (
    <section className="workspace inspector" aria-label="Inspector">
      <div className="workspace-tabs" role="tablist" aria-label="Inspector views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'diff'}
          className={`workspace-tab${tab === 'diff' ? ' is-active' : ''}`}
          onClick={() => setTab('diff')}
        >
          Diff
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'preview'}
          className={`workspace-tab${tab === 'preview' ? ' is-active' : ''}`}
          onClick={() => setTab('preview')}
        >
          Preview
        </button>
      </div>
      <div className="workspace-body">
        {tab === 'diff' ? <DiffView sessionId={sessionId} /> : <Preview sessionId={sessionId} />}
      </div>
    </section>
  )
}
