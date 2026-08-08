import { DatabaseSync, StatementSync } from 'node:sqlite'

import { BUDGET_SCOPES, EMPTY_BUDGETS } from '../shared/budget'
import type { BudgetScope, Budgets } from '../shared/budget'

/** The session cap defaults to $5; time windows are uncapped until set. */
const DEFAULT_SESSION_BUDGET_USD = 5

/**
 * A tiny persisted key–value store for user settings (distinct from the
 * append-only event log — settings are mutable state, not history). Backed by
 * node:sqlite so it survives restarts with no native deps.
 */
export class SettingsStore {
  #db: DatabaseSync
  #get: StatementSync
  #set: StatementSync
  #delete: StatementSync

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.#get = this.#db.prepare('SELECT value FROM settings WHERE key = ?')
    this.#set = this.#db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    this.#delete = this.#db.prepare('DELETE FROM settings WHERE key = ?')
  }

  /**
   * All configured caps. Time windows are null (no cap) until set; the session
   * cap always falls back to the $5 safety floor when unset, so a runaway
   * session is guarded even with no other budgets configured.
   */
  budgets(): Budgets {
    const result: Budgets = { ...EMPTY_BUDGETS }
    for (const scope of BUDGET_SCOPES) {
      result[scope] = this.#readCap(scope)
    }
    result.session ??= DEFAULT_SESSION_BUDGET_USD
    return result
  }

  /** Set (positive number) or clear (null) the cap for one scope. */
  setBudget(scope: BudgetScope, usd: number | null): void {
    if (usd === null || !Number.isFinite(usd) || usd <= 0) {
      this.#delete.run(this.#key(scope))
      return
    }
    this.#set.run(this.#key(scope), String(usd))
  }

  close(): void {
    this.#db.close()
  }

  #key(scope: BudgetScope): string {
    return `budget.${scope}`
  }

  #readCap(scope: BudgetScope): number | null {
    const row = this.#get.get(this.#key(scope)) as { value: string } | undefined
    if (row === undefined) {
      return null
    }
    const parsed = Number(row.value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
}
