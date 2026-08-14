import { useEffect, useState } from 'react'

import type { EventPayloads, StoredEvent } from '../../../shared/events'
import { useSessions } from '../state/sessions'

interface Checkpoint {
  id: string
  label: string
  sha: string
}

function isMine(event: StoredEvent, sessionId: string): boolean {
  return (
    event.type === 'checkpoint.created' &&
    (event.payload as EventPayloads['checkpoint.created']).sessionId === sessionId
  )
}

function toCheckpoint(event: StoredEvent): Checkpoint {
  const payload = event.payload as EventPayloads['checkpoint.created']
  return { id: payload.checkpointId, label: payload.label, sha: payload.sha }
}

/**
 * Snapshot and rewind an isolated agent's worktree. Take a checkpoint before a
 * risky change; if the agent goes down a bad path, rewind to it and steer
 * differently instead of cancelling and starting over. Only for isolated agents
 * (those on their own branch); the checkpoints stream from the log.
 */
export function Checkpoints({ sessionId }: { sessionId?: string | null }): React.JSX.Element {
  const { sessions } = useSessions()
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const isolated = sessions.find((session) => session.id === sessionId)?.branch !== undefined

  useEffect(() => {
    setCheckpoints([])
    const bridge = window.agentinator
    if (bridge === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.tail(500).then((page) => {
      if (!cancelled) {
        setCheckpoints(page.filter((event) => isMine(event, sessionId)).map(toCheckpoint))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      if (isMine(event, sessionId)) {
        setCheckpoints((previous) => [...previous, toCheckpoint(event)])
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  if (sessionId === null || sessionId === undefined) {
    return <p className="empty-state">Select an agent to snapshot its work.</p>
  }
  if (!isolated) {
    return (
      <p className="empty-state">
        Checkpoints are for isolated agents — those running on their own branch.
      </p>
    )
  }

  const snapshot = (event: React.FormEvent): void => {
    event.preventDefault()
    setBusy(true)
    void window.agentinator?.checkpoints.create(sessionId, label.trim()).finally(() => {
      setBusy(false)
      setLabel('')
    })
  }

  const rewind = (checkpoint: Checkpoint): void => {
    void window.agentinator?.checkpoints.restore(sessionId, checkpoint.id, checkpoint.sha)
  }

  return (
    <div className="checkpoints" aria-label="Checkpoints">
      <form className="checkpoint-new" onSubmit={snapshot}>
        <input
          className="checkpoint-label-input"
          value={label}
          onChange={(changed) => setLabel(changed.target.value)}
          placeholder="Label this checkpoint…"
          aria-label="Checkpoint label"
        />
        <button type="submit" className="checkpoint-take" disabled={busy}>
          {busy ? 'Saving…' : 'Checkpoint'}
        </button>
      </form>
      {checkpoints.length === 0 ? (
        <p className="empty-state">
          No checkpoints yet. Snapshot the worktree before a risky change, then rewind if it goes
          wrong.
        </p>
      ) : (
        <ul className="checkpoint-list">
          {checkpoints.map((checkpoint, index) => (
            <li key={checkpoint.id} className="checkpoint-row">
              <span className="checkpoint-name">
                {checkpoint.label === '' ? `Checkpoint ${index + 1}` : checkpoint.label}
              </span>
              <button
                type="button"
                className="checkpoint-rewind"
                aria-label={`Rewind to ${checkpoint.label === '' ? `checkpoint ${index + 1}` : checkpoint.label}`}
                onClick={() => rewind(checkpoint)}
              >
                Rewind
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
