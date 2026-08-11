/** Default pause after a preview page loads before it's captured, in ms. Long
 * enough for console/network events to flush AND for typical async data (Apollo
 * mocks, fetches) to resolve, so the shot isn't a mid-load flicker of the
 * pre-data state. Configurable per workspace when a page needs longer. */
export const DEFAULT_SETTLE_MS = 600

/** Longest settle a user can configure — a guard so a fat-fingered value can't
 * hang every capture for minutes. */
export const MAX_SETTLE_MS = 10_000

/** Clamp a user-supplied settle delay to a sane range; fall back to the default
 * for anything non-finite or negative. */
export function clampSettleMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) {
    return DEFAULT_SETTLE_MS
  }
  return Math.min(ms, MAX_SETTLE_MS)
}
