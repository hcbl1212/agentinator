import type { BudgetScope } from '../shared/budget'

/**
 * The ISO timestamp marking the start of the current calendar period for a
 * scope, in local time (weeks start Monday). Returns null for 'session',
 * which isn't a time window. Compared lexicographically against event `ts`
 * values — safe because both are `toISOString()` output.
 */
export function periodStartIso(scope: BudgetScope, now: Date): string | null {
  if (scope === 'session') {
    return null
  }
  const start = new Date(now.getTime())
  start.setMinutes(0, 0, 0)
  if (scope === 'hour') {
    return start.toISOString()
  }
  start.setHours(0)
  if (scope === 'day') {
    return start.toISOString()
  }
  if (scope === 'week') {
    const daysFromMonday = (start.getDay() + 6) % 7
    start.setDate(start.getDate() - daysFromMonday)
    return start.toISOString()
  }
  start.setDate(1)
  return start.toISOString()
}
