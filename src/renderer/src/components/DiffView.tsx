import { useEffect, useState } from 'react'

import type { StoredEvent } from '../../../shared/events'
import { mergeDiff, toFileDiffs } from '../diff/diffFormat'

/**
 * The cumulative diff of the work so far — one section per file, showing its
 * newest patch with add/delete/hunk coloring. Loads the current diffs and
 * updates live as file.diffed events land.
 */
export function DiffView(): React.JSX.Element {
  const [events, setEvents] = useState<StoredEvent[]>([])

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.diffs().then((diffs) => {
      if (!cancelled) {
        setEvents(diffs)
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      if (event.type === 'file.diffed') {
        setEvents((previous) => mergeDiff(previous, event))
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const files = toFileDiffs(events)

  if (files.length === 0) {
    return (
      <section className="pane diff-pane" aria-label="Diff">
        <p className="empty-state">
          File changes appear here as agents edit — the cumulative diff.
        </p>
      </section>
    )
  }

  return (
    <section className="pane diff-pane" aria-label="Diff">
      {files.map((file) => (
        <section key={file.path} className="diff-file">
          <header className="diff-file-head">
            <span className="diff-file-path">{file.path}</span>
            <span className="diff-file-stat">
              <span className="tone-ok">+{file.additions}</span>{' '}
              <span className="tone-err">−{file.deletions}</span>
            </span>
          </header>
          <pre className="diff-body">
            {file.lines.map((line, index) => (
              <code key={index} className={`diff-line diff-${line.kind}`}>
                {line.text}
              </code>
            ))}
          </pre>
        </section>
      ))}
    </section>
  )
}
