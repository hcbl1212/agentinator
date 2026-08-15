import { useEffect, useState } from 'react'

import type { ConsoleEntry, EventPayloads, NetworkEntry, StoredEvent } from '../../../shared/events'

interface Shot {
  ref: string
  width: number
  height: number
  console: ConsoleEntry[]
  network: NetworkEntry[]
}

function toShot(event: StoredEvent): Shot {
  const payload = event.payload as EventPayloads['preview.captured']
  return {
    ref: payload.ref,
    width: payload.width,
    height: payload.height,
    console: payload.console ?? [],
    network: payload.network ?? [],
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
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [componentRoot, setComponentRoot] = useState('')
  const [componentFile, setComponentFile] = useState('')
  const [componentWrapper, setComponentWrapper] = useState('')
  const [componentProps, setComponentProps] = useState('')
  const [inferring, setInferring] = useState(false)
  const [wrappering, setWrappering] = useState(false)
  const [setupOpen, setSetupOpen] = useState(true)
  const [settleMs, setSettleMs] = useState('')
  const [worktreePreview, setWorktreePreview] = useState(false)
  const [serverCommand, setServerCommand] = useState('')
  const [serverState, setServerState] = useState<'idle' | 'starting' | 'ready' | 'none' | 'failed'>(
    'idle',
  )
  const [serverUrl, setServerUrl] = useState('')
  const [serverError, setServerError] = useState('')
  const [serverCount, setServerCount] = useState(0)
  const [depsStale, setDepsStale] = useState(false)

  // Load the configured preview target (a real dev-server URL, or blank for the
  // bundled sample) and any pinned component once.
  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.settings.getPreviewTarget().then((url) => {
      if (!cancelled) {
        setTarget(url ?? '')
      }
    })
    void bridge.settings.getPreviewSettleMs().then((ms) => {
      if (!cancelled) {
        setSettleMs(String(ms))
      }
    })
    void bridge.settings.getWorktreePreview().then((on) => {
      if (!cancelled) {
        setWorktreePreview(on)
      }
    })
    void bridge.settings.getPreviewServerCommand().then((command) => {
      if (!cancelled) {
        setServerCommand(command)
      }
    })
    void bridge.preview.worktreeServerCount().then((n) => {
      if (!cancelled) {
        setServerCount(n)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Seed the latest capture from the log, keep it live off broadcasts, and load
  // each shot's PNG by ref as it becomes current.
  useEffect(() => {
    // Reset everything tied to the previous agent so its screenshot, capture
    // error, worktree-server status, and pinned component don't linger on the
    // newly selected one — a fresh agent starts blank.
    setShot(null)
    setSrc(null)
    setMark(null)
    setNote('')
    setError(null)
    setServerState('idle')
    setServerUrl('')
    setServerError('')
    setDepsStale(false)
    setComponentRoot('')
    setComponentFile('')
    setComponentWrapper('')
    setComponentProps('')
    const bridge = window.agentinator
    if (bridge === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    let cancelled = false
    // Load this agent's pinned component (if any); other agents keep their own.
    void bridge.preview.getComponent(sessionId).then((pinned) => {
      if (!cancelled && pinned !== null) {
        setComponentRoot(pinned.root)
        setComponentFile(pinned.file)
        setComponentWrapper(pinned.wrapper ?? '')
        setComponentProps(pinned.props ?? '')
      }
    })
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
    setError(null)
    void bridge.preview
      .capture(sessionId)
      .catch((reason: unknown) => {
        // Surface a failed capture (e.g. a pinned component whose app root
        // doesn't exist) instead of leaving the stale shot with no feedback.
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const saveTarget = (): void => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    const trimmed = target.trim()
    void bridge.settings.setPreviewTarget(trimmed === '' ? null : trimmed)
  }

  // Persist the settle delay; a blank field clears it back to the default.
  const saveSettle = (): void => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    const trimmed = settleMs.trim()
    const ms = Number(trimmed)
    void bridge.settings.setPreviewSettleMs(trimmed === '' || !Number.isFinite(ms) ? null : ms)
  }

  const refreshServerCount = (): void => {
    void window.agentinator?.preview.worktreeServerCount().then(setServerCount)
  }

  // Toggle rendering the selected agent's isolated worktree (its branch) via a
  // harness-run dev server. Turning it on starts the server eagerly (so the
  // first capture isn't slow) and reports progress; turning it off stops every
  // running server.
  const toggleWorktreePreview = (on: boolean): void => {
    setWorktreePreview(on)
    setDepsStale(false)
    const preview = window.agentinator?.preview
    void window.agentinator?.settings.setWorktreePreview(on)
    if (!on) {
      setServerState('idle')
      void preview?.stopWorktreeServers().then(refreshServerCount)
      return
    }
    if (preview === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    setServerState('starting')
    void preview
      .startWorktreeServer(sessionId)
      .then((result) => {
        if (result === null) {
          setServerState('none')
        } else {
          setServerState('ready')
          setServerUrl(result.url)
          // Warn if the agent changed deps — the linked node_modules is stale.
          void preview.worktreeDepsChanged(sessionId).then(setDepsStale)
        }
      })
      .catch((reason: unknown) => {
        setServerState('failed')
        setServerError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(refreshServerCount)
  }

  const stopServers = (): void => {
    setServerState('idle')
    void window.agentinator?.preview.stopWorktreeServers().then(refreshServerCount)
  }

  const saveServerCommand = (): void => {
    const trimmed = serverCommand.trim()
    void window.agentinator?.settings.setPreviewServerCommand(trimmed === '' ? null : trimmed)
  }

  // Pin a component to render in isolation (through the dev server above), or
  // clear the pin to go back to the whole app.
  const saveComponent = (): void => {
    const bridge = window.agentinator
    if (bridge === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    const file = componentFile.trim()
    const wrapper = componentWrapper.trim()
    const props = componentProps.trim()
    void bridge.preview.setComponent(
      sessionId,
      componentRoot.trim(),
      file === '' ? null : file,
      wrapper === '' ? null : wrapper,
      props === '' ? null : props,
    )
  }

  const clearComponent = (): void => {
    setComponentRoot('')
    setComponentFile('')
    setComponentWrapper('')
    setComponentProps('')
    const bridge = window.agentinator
    if (bridge === undefined || sessionId === null || sessionId === undefined) {
      return
    }
    void bridge.preview.setComponent(sessionId, '', null)
  }

  // Ask the agent to set the component up for isolated preview — generate its
  // props, or generate a context wrapper. Shared plumbing: both read the pinned
  // root+file, run the bridge call, apply the result, and surface any error.
  const runSetup = (
    call: (root: string, file: string) => Promise<string>,
    apply: (result: string) => void,
    setBusy: (busy: boolean) => void,
  ): void => {
    const root = componentRoot.trim()
    const file = componentFile.trim()
    if (root === '' || file === '') {
      return
    }
    setBusy(true)
    setError(null)
    void call(root, file)
      .then(apply)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setBusy(false))
  }

  const inferProps = (): void => {
    const preview = window.agentinator?.preview
    if (preview !== undefined) {
      runSetup(preview.inferProps, setComponentProps, setInferring)
    }
  }

  const inferWrapper = (): void => {
    const preview = window.agentinator?.preview
    if (preview !== undefined) {
      runSetup(preview.inferWrapper, setComponentWrapper, setWrappering)
    }
  }

  // Native pickers so the app root and files aren't hand-typed.
  const chooseRoot = (): void => {
    void window.agentinator?.preview.chooseFolder().then((dir) => {
      if (dir !== null) {
        setComponentRoot(dir)
      }
    })
  }

  const chooseFile = (apply: (file: string) => void): void => {
    void window.agentinator?.preview.chooseFile(componentRoot.trim()).then((file) => {
      if (file !== null) {
        apply(file)
      }
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
      <form
        className="preview-target"
        onSubmit={(event) => {
          event.preventDefault()
          saveTarget()
        }}
      >
        <input
          className="preview-target-input"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="Preview URL — blank for the bundled sample"
          aria-label="Preview target URL"
        />
        <button type="submit" className="preview-target-save">
          Set
        </button>
      </form>
      <label className="preview-settle">
        <span className="preview-field-label">Settle</span>
        <input
          type="number"
          className="preview-settle-input"
          value={settleMs}
          min={0}
          step={100}
          onChange={(event) => setSettleMs(event.target.value)}
          onBlur={saveSettle}
          aria-label="Capture settle delay in milliseconds"
        />
        <span className="preview-settle-unit">ms — wait before capturing so async data loads</span>
      </label>
      <label className="preview-worktree">
        <input
          type="checkbox"
          checked={worktreePreview}
          onChange={(event) => toggleWorktreePreview(event.target.checked)}
          aria-label="Preview the selected agent's branch"
        />
        <span>Preview the selected agent&rsquo;s branch (its worktree)</span>
      </label>
      {worktreePreview && (
        <>
          <label className="preview-settle">
            <span className="preview-field-label">Dev cmd</span>
            <input
              className="preview-settle-input preview-cmd-input"
              value={serverCommand}
              onChange={(event) => setServerCommand(event.target.value)}
              onBlur={saveServerCommand}
              placeholder="npm run dev"
              aria-label="Worktree dev-server command"
            />
            <span className="preview-settle-unit">
              run in the agent&rsquo;s worktree to serve it
            </span>
          </label>
          <div className="preview-worktree-status" role="status">
            {serverState === 'starting' && <span>Starting dev server…</span>}
            {serverState === 'ready' && <span className="is-ready">Ready · {serverUrl}</span>}
            {serverState === 'none' && (
              <span>Select an isolated agent with a component pinned.</span>
            )}
            {serverState === 'failed' && (
              <span className="is-failed">Dev server failed: {serverError}</span>
            )}
            {serverCount > 0 && (
              <button
                type="button"
                className="preview-server-stop"
                onClick={stopServers}
                aria-label="Stop all preview servers"
              >
                ⑂ Stop {serverCount} server{serverCount === 1 ? '' : 's'}
              </button>
            )}
          </div>
          {depsStale && (
            <p className="preview-deps-warning" role="alert">
              ⚠ Dependencies changed on this branch — the preview may be stale (node_modules is the
              main checkout&rsquo;s). Reinstall in the worktree if the change matters.
            </p>
          )}
        </>
      )}
      {error !== null && (
        <p className="preview-error" role="alert">
          Capture failed: {error}
        </p>
      )}
      <button
        type="button"
        className="preview-row-label preview-disclosure"
        aria-expanded={setupOpen}
        onClick={() => setSetupOpen((open) => !open)}
      >
        <span className="preview-caret" aria-hidden="true">
          {setupOpen ? '▾' : '▸'}
        </span>
        Isolate one component (needs the URL above)
      </button>
      {setupOpen && (
        <form
          className="preview-component"
          aria-label="Component workbench"
          onSubmit={(event) => {
            event.preventDefault()
            saveComponent()
          }}
        >
          <div className="preview-field">
            <span className="preview-field-label">Root</span>
            <input
              className="preview-field-input"
              value={componentRoot}
              onChange={(event) => setComponentRoot(event.target.value)}
              placeholder="App root folder"
              aria-label="Component app root"
            />
            <button
              type="button"
              className="preview-browse"
              onClick={chooseRoot}
              aria-label="Choose app root"
            >
              Browse…
            </button>
          </div>
          <div className="preview-field">
            <span className="preview-field-label">File</span>
            <input
              className="preview-field-input"
              value={componentFile}
              onChange={(event) => setComponentFile(event.target.value)}
              placeholder="e.g. src/components/Cart.tsx"
              aria-label="Component file"
            />
            <button
              type="button"
              className="preview-browse"
              onClick={() => chooseFile(setComponentFile)}
              aria-label="Choose component file"
            >
              Browse…
            </button>
          </div>
          <div className="preview-field">
            <span className="preview-field-label">Wrapper</span>
            <input
              className="preview-field-input"
              value={componentWrapper}
              onChange={(event) => setComponentWrapper(event.target.value)}
              placeholder="optional — a provider for context"
              aria-label="Wrapper file"
            />
            <button
              type="button"
              className="preview-browse"
              onClick={() => chooseFile(setComponentWrapper)}
              aria-label="Choose wrapper file"
            >
              Browse…
            </button>
          </div>
          <div className="preview-field">
            <span className="preview-field-label">Props</span>
            <textarea
              className="preview-field-input preview-props-input"
              value={componentProps}
              onChange={(event) => setComponentProps(event.target.value)}
              placeholder="{ label: 'Hi' } — or click Infer props"
              aria-label="Component props"
              rows={2}
            />
          </div>
          <div className="preview-actions">
            <button
              type="button"
              className="preview-action"
              onClick={inferProps}
              disabled={inferring}
            >
              {inferring ? 'Inferring…' : 'Infer props'}
            </button>
            <button
              type="button"
              className="preview-action"
              onClick={inferWrapper}
              disabled={wrappering}
            >
              {wrappering ? 'Generating…' : 'Infer wrapper'}
            </button>
            <button type="submit" className="preview-action is-primary">
              Pin
            </button>
            <button type="button" className="preview-action" onClick={clearComponent}>
              Clear
            </button>
          </div>
        </form>
      )}
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
      {shot !== null && shot.network.length > 0 && (
        <div className="preview-network" role="region" aria-label="App network">
          <span className="preview-console-label">Network</span>
          {shot.network.map((entry, index) => (
            <p key={index} className={`preview-net-line${entry.ok ? '' : ' is-failed'}`}>
              <span className="preview-net-method">{entry.method}</span>{' '}
              <span className="preview-net-url">{entry.url}</span>{' '}
              <span className="preview-net-status">
                {entry.status === 0 ? 'failed' : entry.status}
              </span>
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
