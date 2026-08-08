/**
 * Spend ceilings can be scoped to a single session or to a rolling calendar
 * window. Every scope has an independent, optional cap (null = no cap).
 */
export const BUDGET_SCOPES = ['session', 'hour', 'day', 'week', 'month'] as const

export type BudgetScope = (typeof BUDGET_SCOPES)[number]

export type Budgets = Record<BudgetScope, number | null>

export const BUDGET_LABELS: Record<BudgetScope, string> = {
  session: 'Session',
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
}

export const EMPTY_BUDGETS: Budgets = {
  session: null,
  hour: null,
  day: null,
  week: null,
  month: null,
}
