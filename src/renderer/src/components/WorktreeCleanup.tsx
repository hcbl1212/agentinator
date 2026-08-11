import { useEffect, useState } from 'react'

/** Human-readable byte size — B up to GB, one decimal for small values. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/**
 * A status-bar control for reclaiming finished agents' git worktrees: the ones
 * whose session has ended but whose checkout still sits on disk. Shows the
 * count and total size, and removes them (and their branches) behind a confirm
 * — nothing runs automatically. Absent when there's nothing to clean.
 */
export function WorktreeCleanup(): React.JSX.Element | null {
  const [summary, setSummary] = useState({ count: 0, bytes: 0 })
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    const refresh = (): void => {
      void bridge.worktrees.summary().then((next) => {
        if (!cancelled) {
          setSummary(next)
        }
      })
    }
    refresh()
    // A finishing agent adds a reclaimable worktree — keep the count live.
    const unsubscribe = bridge.events.onAppended((event) => {
      if (event.type === 'session.ended') {
        refresh()
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  if (summary.count === 0) {
    return null
  }

  const clean = (): void => {
    setBusy(true)
    void window.agentinator?.worktrees
      .cleanup()
      .then(() => {
        setConfirming(false)
        void window.agentinator?.worktrees.summary().then(setSummary)
      })
      .finally(() => setBusy(false))
  }

  const label = `${summary.count} finished worktree${summary.count === 1 ? '' : 's'} · ${formatBytes(
    summary.bytes,
  )}`

  return (
    <span className="worktree-cleanup" aria-label="Finished worktrees">
      <span title="Git worktrees of finished agents still on disk">⑂ {label}</span>
      {confirming ? (
        <>
          <button type="button" className="worktree-clean-confirm" onClick={clean} disabled={busy}>
            {busy ? 'Cleaning…' : `Remove ${summary.count} + branches`}
          </button>
          <button
            type="button"
            className="worktree-clean-cancel"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="worktree-clean" onClick={() => setConfirming(true)}>
          Clean up
        </button>
      )}
    </span>
  )
}
