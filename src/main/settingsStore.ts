import { DatabaseSync, StatementSync } from 'node:sqlite'

const DEFAULT_BUDGET_USD = 5

/**
 * A tiny persisted key–value store for user settings (distinct from the
 * append-only event log — settings are mutable state, not history). Backed by
 * node:sqlite so it survives restarts with no native deps.
 */
export class SettingsStore {
  #db: DatabaseSync
  #get: StatementSync
  #set: StatementSync

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.#get = this.#db.prepare('SELECT value FROM settings WHERE key = ?')
    this.#set = this.#db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
  }

  /** Per-session spend ceiling applied to new sessions. */
  budgetUsd(): number {
    const row = this.#get.get('budgetUsd') as { value: string } | undefined
    if (row === undefined) {
      return DEFAULT_BUDGET_USD
    }
    const parsed = Number(row.value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET_USD
  }

  setBudgetUsd(usd: number): void {
    this.#set.run('budgetUsd', String(usd))
  }

  close(): void {
    this.#db.close()
  }
}
