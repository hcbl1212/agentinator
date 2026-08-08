import { useEffect, useState } from 'react'

import { EMPTY_BUDGETS } from '../../../shared/budget'
import type { Budgets, BudgetScope } from '../../../shared/budget'
import type { EventPayloads } from '../../../shared/events'
import { BudgetPanel } from './BudgetPanel'

/**
 * Live status bar. Total spend is backfilled from the whole log on mount then
 * kept current from live cost events. The session chip shows the active
 * session's spend against its cap (amber near, red at breach); clicking the
 * budget region opens the time-bound budget editor.
 */
export function StatusBar(): React.JSX.Element {
  const [eventCount, setEventCount] = useState<number | null>(null)
  const [tokens, setTokens] = useState({ input: 0, cacheRead: 0 })
  const [totalUsd, setTotalUsd] = useState(0)
  const [sessionUsd, setSessionUsd] = useState(0)
  const [budgets, setBudgets] = useState<Budgets>(EMPTY_BUDGETS)
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void Promise.all([
      bridge.events.count(),
      bridge.events.totalCost(),
      bridge.settings.getBudgets(),
    ]).then(([count, total, loadedBudgets]) => {
      if (!cancelled) {
        setEventCount(count)
        setTotalUsd(total)
        setBudgets(loadedBudgets)
        setLoaded(true)
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setEventCount(event.seq)
      if (event.type === 'session.started') {
        setSessionUsd(0)
      } else if (event.type === 'cost.usage') {
        const payload = event.payload as EventPayloads['cost.usage']
        setTokens((previous) => ({
          input: previous.input + payload.inputTokens,
          cacheRead: previous.cacheRead + payload.cacheReadInputTokens,
        }))
        setTotalUsd((previous) => previous + payload.usd)
        setSessionUsd((previous) => previous + payload.usd)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const tokensSeen = tokens.input + tokens.cacheRead
  const cacheHealth =
    tokensSeen === 0 ? 'cache —' : `cache ${Math.round((tokens.cacheRead / tokensSeen) * 100)}%`

  const changeBudget = (scope: BudgetScope, usd: number | null): void => {
    setBudgets((previous) => ({ ...previous, [scope]: usd }))
    void window.agentinator?.settings.setBudget(scope, usd)
  }

  const sessionCap = budgets.session
  const sessionClass =
    sessionCap === null || sessionUsd < sessionCap * 0.8
      ? ''
      : sessionUsd >= sessionCap
        ? ' budget-over'
        : ' budget-near'
  const sessionLabel =
    sessionCap === null
      ? `session $${sessionUsd.toFixed(2)}`
      : `session $${sessionUsd.toFixed(2)} / $${sessionCap.toFixed(2)}`

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span title="Lifetime spend across the whole log">${totalUsd.toFixed(4)}</span>
      <span>{eventCount === null ? 'log —' : `log ${eventCount} events`}</span>
      <span title="Share of input tokens served from the prompt cache this session">
        {cacheHealth}
      </span>
      <button
        type="button"
        className={`budget budget-button${sessionClass}`}
        title="Time-bound spend ceilings — click to edit"
        onClick={() => setEditing(true)}
      >
        {loaded ? sessionLabel : 'budget —'}
      </button>
      <span className="statusbar-right">v0.1.0</span>
      {editing && loaded && (
        <BudgetPanel budgets={budgets} onChange={changeBudget} onClose={() => setEditing(false)} />
      )}
    </footer>
  )
}
