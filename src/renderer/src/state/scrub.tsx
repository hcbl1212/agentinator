import { createContext, useContext, useEffect, useMemo, useState } from 'react'

/**
 * The global timeline scrub point. `seq` is null when live (views follow new
 * events); a number pins every scrub-aware view to the log as of that sequence,
 * so the transcript rewinds in lockstep. `max` is the highest sequence in the
 * log — the slider's right edge — kept current from live appends.
 */
interface ScrubState {
  seq: number | null
  max: number
  setSeq(seq: number | null): void
}

const ScrubContext = createContext<ScrubState | null>(null)

export function ScrubProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [seq, setSeq] = useState<number | null>(null)
  const [max, setMax] = useState(0)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    // The log is append-only, so its event count is the highest sequence.
    void bridge.events.count().then((count) => {
      if (!cancelled) {
        setMax((was) => Math.max(was, count))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setMax((was) => Math.max(was, event.seq))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo<ScrubState>(() => ({ seq, max, setSeq }), [seq, max])
  return <ScrubContext.Provider value={value}>{children}</ScrubContext.Provider>
}

export function useScrub(): ScrubState {
  const state = useContext(ScrubContext)
  if (state === null) {
    throw new Error('useScrub must be used within a ScrubProvider')
  }
  return state
}
