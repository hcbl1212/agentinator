import { useEffect, useState } from 'react'

import { EMPTY_BUDGETS } from '../../../shared/budget'
import type { Budgets, BudgetScope } from '../../../shared/budget'
import type { EventPayloads } from '../../../shared/events'
import type { AccountUsage } from '../../../shared/usage'
import { BudgetPanel } from './BudgetPanel'
import { CredentialsPanel } from './CredentialsPanel'
import { WorktreeCleanup } from './WorktreeCleanup'

const SHORT_WINDOW: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

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
  const [budgets, setBudgets] = useState<Budgets>(EMPTY_BUDGETS)
  const [usage, setUsage] = useState<AccountUsage | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editingKeys, setEditingKeys] = useState(false)

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
      // Backfill the last plan-usage snapshot so the gauge survives a reload —
      // otherwise it only reappears once the next agent turn re-reports usage.
      bridge.events.search('account.usage', 1),
    ]).then(([count, total, loadedBudgets, usageEvents]) => {
      if (!cancelled) {
        setEventCount(count)
        setTotalUsd(total)
        setBudgets(loadedBudgets)
        const lastUsage = usageEvents.at(-1)
        if (lastUsage?.type === 'account.usage') {
          setUsage(lastUsage.payload as EventPayloads['account.usage'])
        }
        setLoaded(true)
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setEventCount(event.seq)
      if (event.type === 'cost.usage') {
        const payload = event.payload as EventPayloads['cost.usage']
        setTokens((previous) => ({
          input: previous.input + payload.inputTokens,
          cacheRead: previous.cacheRead + payload.cacheReadInputTokens,
        }))
        setTotalUsd((previous) => previous + payload.usd)
      } else if (event.type === 'account.usage') {
        setUsage(event.payload as EventPayloads['account.usage'])
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

  // On a subscription the plan windows are the real limit — dollars are only an
  // estimate of what it would have cost on the API.
  const onSubscription = usage?.mode === 'subscription'
  const planGauge =
    onSubscription && usage.windows.length > 0
      ? usage.windows.map((w) => `${SHORT_WINDOW[w.key] ?? w.key} ${Math.round(w.utilization)}%`)
      : null
  const spendTitle = onSubscription
    ? `Estimated cost — you're on the ${usage.plan ?? 'subscription'} plan, not billed per token`
    : 'Lifetime spend across the whole log'

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span title={spendTitle}>{`${onSubscription ? 'est. ' : ''}$${totalUsd.toFixed(4)}`}</span>
      {planGauge !== null && (
        <span className="plan-gauge" aria-label="Plan usage" title="Plan rate-limit windows used">
          {planGauge.join(' · ')}
        </span>
      )}
      <span>{eventCount === null ? 'log —' : `log ${eventCount} events`}</span>
      <span title="Share of input tokens served from the prompt cache this session">
        {cacheHealth}
      </span>
      <button
        type="button"
        className="budget budget-button"
        title="Spend ceilings — click to edit"
        onClick={() => setEditing(true)}
      >
        {loaded ? 'budgets' : 'budget —'}
      </button>
      <button
        type="button"
        className="budget budget-button"
        title="API keys — for switching an agent off its subscription"
        onClick={() => setEditingKeys(true)}
      >
        keys
      </button>
      <WorktreeCleanup />
      <span className="statusbar-right">v0.1.0</span>
      {editing && loaded && (
        <BudgetPanel budgets={budgets} onChange={changeBudget} onClose={() => setEditing(false)} />
      )}
      {editingKeys && <CredentialsPanel onClose={() => setEditingKeys(false)} />}
    </footer>
  )
}
