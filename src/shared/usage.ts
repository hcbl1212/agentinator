/**
 * A vendor-neutral view of an account's billing posture, normalized from a
 * provider's own (often experimental, always messy) usage shape. The app only
 * ever sees this — so when a vendor's raw usage API churns, the blast radius is
 * the one adapter mapper that produces this, never the UI.
 */
export type BillingMode = 'subscription' | 'metered' | 'unknown'

/** One rate-limit window: how full it is and when it resets. */
export interface UsageWindow {
  key: string
  label: string
  /** 0–100. */
  utilization: number
  /** ISO 8601, or null when the vendor doesn't say. */
  resetsAt: string | null
}

/** Pay-as-you-go past the plan limit, when the account allows it. */
export interface OverageInfo {
  enabled: boolean
  usedUsd: number
  limitUsd: number | null
}

export interface AccountUsage {
  mode: BillingMode
  /** Plan name for a subscription ('max', 'pro', …); null when metered. */
  plan: string | null
  windows: UsageWindow[]
  overage: OverageInfo | null
  /** The session's running cost — real money when metered, an estimate on a
   * subscription. */
  sessionCostUsd: number
}

/** A live rate-limit signal, normalized from a provider's push event. */
export type LimitStatus = 'ok' | 'warning' | 'rejected'

export interface AccountLimit {
  status: LimitStatus
  /** Which window bound (e.g. 'five_hour'), or null. */
  window: string | null
  /** When it frees up, epoch ms, or null. */
  resetsAtMs: number | null
  utilization: number | null
  /** Whether overage/credits could keep work moving past the limit. */
  overageAvailable: boolean
  overageInUse: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const STATUS: Record<string, LimitStatus> = {
  allowed: 'ok',
  allowed_warning: 'warning',
  rejected: 'rejected',
}

/**
 * Normalize a provider's push rate-limit signal into {@link AccountLimit}. Epoch
 * resets come back in seconds or milliseconds depending on the field; anything
 * below the year-2001-in-ms mark is treated as seconds.
 */
export function normalizeLimit(raw: unknown): AccountLimit {
  if (!isRecord(raw)) {
    return {
      status: 'ok',
      window: null,
      resetsAtMs: null,
      utilization: null,
      overageAvailable: false,
      overageInUse: false,
    }
  }
  const status = str(raw['status'])
  const resets = numOrNull(raw['resetsAt'])
  const overageStatus = str(raw['overageStatus'])
  return {
    status: (status !== null && STATUS[status]) || 'ok',
    window: str(raw['rateLimitType']),
    resetsAtMs: resets === null ? null : resets < 1e12 ? resets * 1000 : resets,
    utilization: numOrNull(raw['utilization']),
    overageAvailable:
      overageStatus === 'allowed' ||
      overageStatus === 'allowed_warning' ||
      raw['canUserPurchaseCredits'] === true,
    overageInUse: raw['isUsingOverage'] === true || raw['overageInUse'] === true,
  }
}

/** The stable windows we surface, in display order. */
const WINDOWS: { key: string; label: string }[] = [
  { key: 'five_hour', label: 'Session · 5h' },
  { key: 'seven_day', label: 'Weekly' },
]

function readWindow(raw: Record<string, unknown>, key: string, label: string): UsageWindow | null {
  const window = raw[key]
  if (!isRecord(window)) {
    return null
  }
  const utilization = window['utilization']
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
    return null
  }
  return { key, label, utilization, resetsAt: str(window['resets_at']) }
}

/** Overage lives in `spend` (cleaner) or `extra_usage` depending on the CLI
 * build; read whichever is present. Amounts are minor units (cents). */
function readOverage(rateLimits: Record<string, unknown>): OverageInfo | null {
  const spend = rateLimits['spend']
  if (isRecord(spend)) {
    const used = isRecord(spend['used']) ? num(spend['used']['amount_minor']) : 0
    const limit = isRecord(spend['limit']) ? spend['limit']['amount_minor'] : undefined
    return {
      enabled: spend['enabled'] === true,
      usedUsd: used / 100,
      limitUsd: typeof limit === 'number' ? limit / 100 : null,
    }
  }
  const extra = rateLimits['extra_usage']
  if (isRecord(extra)) {
    const limit = extra['monthly_limit']
    return {
      enabled: extra['is_enabled'] === true,
      usedUsd: num(extra['used_credits']) / 100,
      limitUsd: typeof limit === 'number' ? limit / 100 : null,
    }
  }
  return null
}

/**
 * Map a provider's raw usage response into {@link AccountUsage}. Every field is
 * read defensively: a subscription with plan rate limits, a metered API key
 * (no limits), or anything unrecognized all produce a sane, typed result.
 */
export function normalizeUsage(raw: unknown): AccountUsage {
  if (!isRecord(raw)) {
    return { mode: 'unknown', plan: null, windows: [], overage: null, sessionCostUsd: 0 }
  }
  const plan = str(raw['subscription_type'])
  const limitsAvailable = raw['rate_limits_available'] === true
  const mode: BillingMode =
    plan !== null ? 'subscription' : raw['rate_limits_available'] === false ? 'metered' : 'unknown'

  const rateLimits = isRecord(raw['rate_limits']) ? raw['rate_limits'] : undefined
  const windows =
    limitsAvailable && rateLimits !== undefined
      ? WINDOWS.map(({ key, label }) => readWindow(rateLimits, key, label)).filter(
          (window): window is UsageWindow => window !== null,
        )
      : []
  const overage = rateLimits !== undefined ? readOverage(rateLimits) : null
  const session = isRecord(raw['session']) ? raw['session'] : undefined

  return {
    mode,
    plan,
    windows,
    overage,
    sessionCostUsd: session === undefined ? 0 : num(session['total_cost_usd']),
  }
}
