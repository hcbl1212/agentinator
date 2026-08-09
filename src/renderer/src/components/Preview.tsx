import { useEffect, useState } from 'react'

import type { ConsoleEntry, EventPayloads, StoredEvent } from '../../../shared/events'

interface Shot {
  ref: string
  width: number
  height: number
  console: ConsoleEntry[]
}

function toShot(event: StoredEvent): Shot {
  const payload = event.payload as EventPayloads['preview.captured']
  return {
    ref: payload.ref,
    width: payload.width,
    height: payload.height,
    console: payload.console ?? [],
  }
}

function isMine(event: StoredEvent, sessionId: string): boolean {
  return (
    event.type === 'preview.captured' &&
    (event.payload as EventPayloads['preview.captured']).sessionId === sessionId
  )
}

/**
 * The visual feedback loop's pane: a screenshot of the target app the selected
 * agent is working on. Capture on demand (later, agents trigger it); the newest
 * shot streams in from the log and its PNG loads by ref — bytes never live in
 * the renderer's event stream.
 */
interface Mark {
  xPct: number
  yPct: number
}

export function Preview({ sessionId }: { sessionId?: string | null }): React.JSX.Element {
  const [shot, setShot] = useState<Shot | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mark, setMark] = useState<Mark | null>(null)
  const [note, setNote] = useState('')

  // Seed the latest capture from the log, keep it live off broadcasts, and load
  // each shot's PNG by ref as it becomes current.
  useEffect(() => {
    setShot(null)
    setSrc(null)
    setMark(null)
    setNote('')
    const bridge = window.agentinator
    if (bridge === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    let cancelled = false
    const show = (event: StoredEvent): void => {
      setShot(toShot(event))
      // A new screenshot invalidates any pending annotation on the old one.
      setMark(null)
      const ref = (event.payload as EventPayloads['preview.captured']).ref
      void bridge.preview.image(ref).then((base64) => {
        if (!cancelled && base64 !== null) {
          setSrc(`data:image/png;base64,${base64}`)
        }
      })
    }
    void bridge.events.search('preview.captured', 30).then((events) => {
      if (cancelled) {
        return
      }
      const mine = events.filter((event) => isMine(event, sessionId))
      const last = mine[mine.length - 1]
      if (last !== undefined) {
        show(last)
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      if (isMine(event, sessionId)) {
        show(event)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  const capture = (): void => {
    const bridge = window.agentinator
    if (bridge === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    setBusy(true)
    void bridge.preview.capture(sessionId).finally(() => {
      setBusy(false)
    })
  }

  // Point at it: turn a click on the screenshot into a normalized mark.
  const pointAt = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMark({
      xPct: ((event.clientX - rect.left) / rect.width) * 100,
      yPct: ((event.clientY - rect.top) / rect.height) * 100,
    })
  }

  // Send the marked spot + note + the screenshot itself into the agent's
  // context, reusing the ordinary message channel (bytes go to the model, the
  // log keeps only the imageCount).
  const send = (spot: Mark, image: string): void => {
    const bridge = window.agentinator
    if (bridge === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    const data = image.slice(image.indexOf(',') + 1)
    const where = `${Math.round(spot.xPct)}% across, ${Math.round(spot.yPct)}% down`
    const trimmed = note.trim()
    const text = `Pointing at the app preview at ${where}${trimmed === '' ? '' : `: ${trimmed}`}.`
    void bridge.agent.send(sessionId, text, [{ mediaType: 'image/png', data }])
    setMark(null)
    setNote('')
  }

  if (sessionId === null || sessionId === undefined) {
    return (
      <section className="pane preview" aria-label="App preview">
        <p className="empty-state">Select an agent to preview its app.</p>
      </section>
    )
  }

  return (
    <section className="pane preview" aria-label="App preview">
      <div className="preview-toolbar">
        <button type="button" className="preview-capture" onClick={capture} disabled={busy}>
          {busy ? 'Capturing…' : 'Capture'}
        </button>
        {shot !== null && (
          <span className="preview-dims">
            {shot.width}×{shot.height}
          </span>
        )}
      </div>
      {src === null ? (
        <p className="empty-state">
          Capture a screenshot of the target app — it renders here, and streams to the agent next.
        </p>
      ) : (
        <>
          <button
            type="button"
            className="preview-frame"
            onClick={pointAt}
            aria-label="Point at the app — click a spot to mark it for the agent"
          >
            <img className="preview-shot" src={src} alt="Latest screenshot of the target app" />
            {mark !== null && (
              <span
                className="preview-mark"
                style={{ left: `${mark.xPct}%`, top: `${mark.yPct}%` }}
                aria-hidden="true"
              />
            )}
          </button>
          {mark !== null && (
            <form
              className="preview-annotate"
              onSubmit={(event) => {
                event.preventDefault()
                send(mark, src)
              }}
            >
              <input
                className="preview-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Tell the agent about this spot…"
                aria-label="Note about the marked spot"
              />
              <button type="submit" className="preview-send">
                Send to agent
              </button>
              <button
                type="button"
                className="preview-cancel-mark"
                onClick={() => {
                  setMark(null)
                  setNote('')
                }}
              >
                Cancel
              </button>
            </form>
          )}
        </>
      )}
      {shot !== null && shot.console.length > 0 && (
        <div className="preview-console" role="region" aria-label="App console">
          <span className="preview-console-label">Console</span>
          {shot.console.map((entry, index) => (
            <p key={index} className={`preview-console-line level-${entry.level}`}>
              <span className="preview-console-level">{entry.level}</span> {entry.text}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
