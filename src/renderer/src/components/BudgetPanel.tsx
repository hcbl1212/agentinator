import { useState } from 'react'

import { BUDGET_LABELS, BUDGET_SCOPES } from '../../../shared/budget'
import type { Budgets, BudgetScope } from '../../../shared/budget'

/**
 * Editable time-bound spend ceilings: session plus hour/day/week/month. A
 * blank field means "no cap". Changes persist immediately per scope.
 */
export function BudgetPanel({
  budgets,
  onChange,
  onClose,
}: {
  budgets: Budgets
  onChange: (scope: BudgetScope, usd: number | null) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="budget-panel" role="dialog" aria-label="Budget settings">
      <div className="budget-panel-head">
        <span className="pane-label">Spend ceilings</span>
        <button
          type="button"
          className="budget-panel-close"
          aria-label="Close budgets"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {BUDGET_SCOPES.map((scope) => (
        <BudgetRow
          key={scope}
          scope={scope}
          value={budgets[scope]}
          onCommit={(usd) => onChange(scope, usd)}
        />
      ))}
      <p className="budget-panel-note">Blank = no cap. Sessions crossing a ceiling are stopped.</p>
    </div>
  )
}

function BudgetRow({
  scope,
  value,
  onCommit,
}: {
  scope: BudgetScope
  value: number | null
  onCommit: (usd: number | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value === null ? '' : String(value))

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed === '') {
      onCommit(null)
      return
    }
    const parsed = Number(trimmed)
    onCommit(Number.isFinite(parsed) && parsed > 0 ? parsed : null)
  }

  return (
    <label className="budget-row">
      <span className="budget-row-label">{BUDGET_LABELS[scope]}</span>
      <span className="budget-row-field">
        $
        <input
          type="number"
          className="budget-input"
          aria-label={`${BUDGET_LABELS[scope]} budget in dollars`}
          step="0.5"
          min="0"
          value={draft}
          onChange={(changed) => setDraft(changed.target.value)}
          onBlur={commit}
          onKeyDown={(key) => {
            if (key.key === 'Enter') {
              commit()
            }
          }}
        />
      </span>
    </label>
  )
}
