import { useState } from 'react'

import { DiffView } from './DiffView'
import { Timeline } from './Timeline'

type Tab = 'timeline' | 'diff'

/** The center pane: a tabbed view over the running work (timeline / diff). */
export function Workspace(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('timeline')

  return (
    <section className="workspace" aria-label="Workspace">
      <div className="workspace-tabs" role="tablist" aria-label="Workspace views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'timeline'}
          className={`workspace-tab${tab === 'timeline' ? ' is-active' : ''}`}
          onClick={() => setTab('timeline')}
        >
          Timeline
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'diff'}
          className={`workspace-tab${tab === 'diff' ? ' is-active' : ''}`}
          onClick={() => setTab('diff')}
        >
          Diff
        </button>
      </div>
      <div className="workspace-body">{tab === 'timeline' ? <Timeline /> : <DiffView />}</div>
    </section>
  )
}
