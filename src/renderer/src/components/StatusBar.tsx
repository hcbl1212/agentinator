import { useEffect, useState } from 'react'

import type { EventPayloads } from '../../../shared/events'

/**
 * Live status bar. Total spend is backfilled from the whole log on mount then
 * kept current from live cost events. The budget region shows the active
 * session's spend against the editable per-session cap, warming to amber as it
 * approaches and red at breach.
 */
export function StatusBar(): React.JSX.Element {
  const [eventCount, setEventCount] = useState<number | null>(null)
  const [tokens, setTokens] = useState({ input: 0, cacheRead: 0 })
  const [totalUsd, setTotalUsd] = useState(0)
  const [sessionUsd, setSessionUsd] = useState(0)
  const [budgetUsd, setBudgetUsd] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void Promise.all([
      bridge.events.count(),
      bridge.events.totalCost(),
      bridge.settings.getBudgetUsd(),
    ]).then(([count, total, budget]) => {
      if (!cancelled) {
        setEventCount(count)
        setTotalUsd(total)
        setBudgetUsd(budget)
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

  const commitBudget = (): void => {
    setEditing(false)
    const parsed = Number(draft)
    if (Number.isFinite(parsed) && parsed > 0) {
      setBudgetUsd(parsed)
      void window.agentinator?.settings.setBudgetUsd(parsed)
    }
  }

  const budgetClass =
    budgetUsd === null || sessionUsd < budgetUsd * 0.8
      ? ''
      : sessionUsd >= budgetUsd
        ? ' budget-over'
        : ' budget-near'

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span title="Lifetime spend across the whole log">${totalUsd.toFixed(4)}</span>
      <span>{eventCount === null ? 'log —' : `log ${eventCount} events`}</span>
      <span title="Share of input tokens served from the prompt cache this session">
        {cacheHealth}
      </span>
      {editing ? (
        <span className="budget">
          budget $
          <input
            type="number"
            className="budget-input"
            aria-label="Session budget in dollars"
            step="0.5"
            min="0"
            autoFocus
            value={draft}
            onChange={(changed) => setDraft(changed.target.value)}
            onBlur={commitBudget}
            onKeyDown={(key) => {
              if (key.key === 'Enter') {
                commitBudget()
              } else if (key.key === 'Escape') {
                setEditing(false)
              }
            }}
          />
        </span>
      ) : (
        <button
          type="button"
          className={`budget budget-button${budgetClass}`}
          title="Per-session spend ceiling — click to edit"
          onClick={() => {
            setDraft(budgetUsd === null ? '' : String(budgetUsd))
            setEditing(true)
          }}
        >
          {budgetUsd === null
            ? 'budget —'
            : `session $${sessionUsd.toFixed(2)} / $${budgetUsd.toFixed(2)}`}
        </button>
      )}
      <span className="statusbar-right">v0.1.0</span>
    </footer>
  )
}
