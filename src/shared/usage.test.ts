import { describe, expect, it } from 'vitest'

import { normalizeUsage } from './usage'

describe('normalizeUsage', () => {
  it('maps a subscription with plan windows, overage, and a running cost', () => {
    // Shape captured live from a real Max account (trimmed + codenamed buckets
    // kept to prove they're ignored).
    const usage = normalizeUsage({
      session: { total_cost_usd: 0.42 },
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 11, resets_at: '2026-08-09T15:30:00Z' },
        seven_day: { utilization: 13 }, // no reset timestamp
        nimbus_quill: { utilization: 0, resets_at: null }, // codenamed → ignored
        spend: {
          enabled: true,
          used: { amount_minor: 0 },
          limit: { amount_minor: 20000 },
        },
      },
    })

    expect(usage.mode).toBe('subscription')
    expect(usage.plan).toBe('max')
    expect(usage.windows).toEqual([
      {
        key: 'five_hour',
        label: 'Session · 5h',
        utilization: 11,
        resetsAt: '2026-08-09T15:30:00Z',
      },
      { key: 'seven_day', label: 'Weekly', utilization: 13, resetsAt: null },
    ])
    expect(usage.overage).toEqual({ enabled: true, usedUsd: 0, limitUsd: 200 })
    expect(usage.sessionCostUsd).toBe(0.42)
  })

  it('maps a metered API-key account to no windows and no overage', () => {
    const usage = normalizeUsage({
      session: { total_cost_usd: 1.5 },
      subscription_type: null,
      rate_limits_available: false,
    })

    expect(usage).toEqual({
      mode: 'metered',
      plan: null,
      windows: [],
      overage: null,
      sessionCostUsd: 1.5,
    })
  })

  it('falls back to unknown for a non-record and for an ambiguous account', () => {
    expect(normalizeUsage(null)).toEqual({
      mode: 'unknown',
      plan: null,
      windows: [],
      overage: null,
      sessionCostUsd: 0,
    })
    // A record with neither a plan nor an explicit "limits unavailable".
    expect(normalizeUsage({ subscription_type: null }).mode).toBe('unknown')
  })

  it('reads overage from extra_usage (with and without a limit) and drops malformed windows', () => {
    const withLimit = normalizeUsage({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: null, // not a record → dropped
        seven_day: { utilization: 'nope' }, // bad utilization → dropped
        extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 30000 },
      },
    })
    expect(withLimit.windows).toEqual([])
    expect(withLimit.overage).toEqual({ enabled: true, usedUsd: 5, limitUsd: 300 })
    expect(withLimit.sessionCostUsd).toBe(0)

    const noLimit = normalizeUsage({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: { extra_usage: { is_enabled: false } },
    })
    expect(noLimit.overage).toEqual({ enabled: false, usedUsd: 0, limitUsd: null })
  })

  it('returns no overage without a spend/extra_usage block, and no windows without rate_limits', () => {
    const noOverage = normalizeUsage({
      subscription_type: 'enterprise',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 50, resets_at: '2026-08-09T15:30:00Z' } },
    })
    expect(noOverage.overage).toBeNull()
    expect(noOverage.windows).toHaveLength(1)

    const noRateLimits = normalizeUsage({ subscription_type: 'max', rate_limits_available: true })
    expect(noRateLimits.windows).toEqual([])
    expect(noRateLimits.overage).toBeNull()
  })

  it('handles a spend block missing its amounts, and present-but-empty rate limits', () => {
    const usage = normalizeUsage({
      subscription_type: 'team',
      rate_limits_available: true, // available but no rate_limits object → no windows
      rate_limits: { spend: { enabled: false } },
    })

    expect(usage.windows).toEqual([])
    expect(usage.overage).toEqual({ enabled: false, usedUsd: 0, limitUsd: null })
  })
})
