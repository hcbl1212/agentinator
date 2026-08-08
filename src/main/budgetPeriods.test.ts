import { describe, expect, it } from 'vitest'

import { periodStartIso } from './budgetPeriods'

// A Wednesday: 2026-08-12T15:37:22 local.
const now = new Date(2026, 7, 12, 15, 37, 22, 500)

describe('periodStartIso', () => {
  it('returns null for the session scope (not a time window)', () => {
    expect(periodStartIso('session', now)).toBeNull()
  })

  it('starts the hour at :00', () => {
    expect(periodStartIso('hour', now)).toBe(new Date(2026, 7, 12, 15, 0, 0, 0).toISOString())
  })

  it('starts the day at local midnight', () => {
    expect(periodStartIso('day', now)).toBe(new Date(2026, 7, 12, 0, 0, 0, 0).toISOString())
  })

  it('starts the week on Monday', () => {
    // 2026-08-12 is a Wednesday → Monday is the 10th.
    expect(periodStartIso('week', now)).toBe(new Date(2026, 7, 10, 0, 0, 0, 0).toISOString())
  })

  it('handles a Sunday by going back to the prior Monday', () => {
    const sunday = new Date(2026, 7, 16, 9, 0, 0)
    expect(periodStartIso('week', sunday)).toBe(new Date(2026, 7, 10, 0, 0, 0, 0).toISOString())
  })

  it('starts the month on the 1st', () => {
    expect(periodStartIso('month', now)).toBe(new Date(2026, 7, 1, 0, 0, 0, 0).toISOString())
  })
})
