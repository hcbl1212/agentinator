import { describe, expect, it } from 'vitest'

import { clampSettleMs, DEFAULT_SETTLE_MS, MAX_SETTLE_MS } from './preview'

describe('clampSettleMs', () => {
  it('passes through an in-range value', () => {
    expect(clampSettleMs(800)).toBe(800)
    expect(clampSettleMs(0)).toBe(0)
  })

  it('caps at the maximum', () => {
    expect(clampSettleMs(MAX_SETTLE_MS + 5000)).toBe(MAX_SETTLE_MS)
  })

  it('falls back to the default for negative or non-finite values', () => {
    expect(clampSettleMs(-1)).toBe(DEFAULT_SETTLE_MS)
    expect(clampSettleMs(Number.NaN)).toBe(DEFAULT_SETTLE_MS)
  })
})
