import { useEffect, useState } from 'react'

import type { EventPayloads, StoredEvent } from '../../../shared/events'
import type { FileDiff } from '../diff/diffFormat'
import { mergeDiff, toFileDiffs } from '../diff/diffFormat'

/** The per-file diff sections — shared between the inspector's Diff tab and
 * the review workbench's combined diff. */
export function DiffFiles({ files }: { files: FileDiff[] }): React.JSX.Element {
  return (
    <>
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
    </>
  )
}

/**
 * The cumulative diff of the selected agent's work — one section per file,
 * showing its newest patch with add/delete/hunk coloring. Scoped to the
 * highlighted agent; with none selected it shows nothing.
 */
export function DiffView({ sessionId }: { sessionId?: string | null }): React.JSX.Element {
  const [events, setEvents] = useState<StoredEvent[]>([])

  useEffect(() => {
    setEvents([])
    const bridge = window.agentinator
    if (bridge === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.diffs(sessionId).then((diffs) => {
      if (!cancelled) {
        setEvents(diffs)
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      if (
        event.type === 'file.diffed' &&
        (event.payload as EventPayloads['file.diffed']).sessionId === sessionId
      ) {
        setEvents((previous) => mergeDiff(previous, event))
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  const files = toFileDiffs(events)

  if (files.length === 0) {
    return (
      <section className="pane diff-pane" aria-label="Diff">
        <p className="empty-state">
          {sessionId === null || sessionId === undefined
            ? 'Select an agent to see its changes.'
            : 'File changes appear here as the agent edits — the cumulative diff.'}
        </p>
      </section>
    )
  }

  return (
    <section className="pane diff-pane" aria-label="Diff">
      <DiffFiles files={files} />
    </section>
  )
}
