import { DatabaseSync, StatementSync } from 'node:sqlite'

import { BUDGET_SCOPES, EMPTY_BUDGETS } from '../shared/budget'
import type { BudgetScope, Budgets } from '../shared/budget'
import { clampSettleMs, DEFAULT_SETTLE_MS } from '../shared/preview'

/** The session cap defaults to $5; time windows are uncapped until set. */
const DEFAULT_SESSION_BUDGET_USD = 5

/** The default dev-server command for worktree preview — Vite-based apps. */
const DEFAULT_SERVER_COMMAND = 'npm run dev'

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
  #selectSecrets: StatementSync

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.#get = this.#db.prepare('SELECT value FROM settings WHERE key = ?')
    this.#set = this.#db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    this.#delete = this.#db.prepare('DELETE FROM settings WHERE key = ?')
    this.#selectSecrets = this.#db.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'credential.%'",
    )
  }

  /**
   * Encrypted-credential storage. The store only ever holds ciphertext handed
   * to it by the CredentialVault — it never sees or produces a plaintext key.
   */
  saveSecret(id: string, ciphertext: string): void {
    this.#set.run(`credential.${id}`, ciphertext)
  }

  readSecret(id: string): string | undefined {
    const row = this.#get.get(`credential.${id}`) as { value: string } | undefined
    return row?.value
  }

  deleteSecret(id: string): void {
    this.#delete.run(`credential.${id}`)
  }

  /** Every stored credential as (providerId, ciphertext) — for loading on boot. */
  secrets(): { id: string; ciphertext: string }[] {
    const rows = this.#selectSecrets.all() as unknown as { key: string; value: string }[]
    return rows.map((row) => ({ id: row.key.slice('credential.'.length), ciphertext: row.value }))
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

  /** Whether new/reopened agents should run on the metered API key rather than
   * the subscription. Off by default — the plan is always the starting point. */
  apiKeyMode(): boolean {
    return (this.#get.get('apiKeyMode') as { value: string } | undefined)?.value === '1'
  }

  setApiKeyMode(on: boolean): void {
    if (on) {
      this.#set.run('apiKeyMode', '1')
    } else {
      this.#delete.run('apiKeyMode')
    }
  }

  /** The app URL the preview captures, or undefined to use the bundled sample.
   * Attach mode: the user runs the dev server, the harness just points at it. */
  previewTarget(): string | undefined {
    return (this.#get.get('previewTarget') as { value: string } | undefined)?.value
  }

  setPreviewTarget(url: string | null): void {
    const trimmed = url?.trim() ?? ''
    if (trimmed === '') {
      this.#delete.run('previewTarget')
    } else {
      this.#set.run('previewTarget', trimmed)
    }
  }

  /** How long a preview capture waits for the page to settle after load, in ms.
   * Falls back to the default when unset or stored garbage; always clamped to a
   * sane range so a bad value can't hang every capture. */
  previewSettleMs(): number {
    const row = this.#get.get('previewSettleMs') as { value: string } | undefined
    if (row === undefined) {
      return DEFAULT_SETTLE_MS
    }
    return clampSettleMs(Number(row.value))
  }

  setPreviewSettleMs(ms: number | null): void {
    if (ms === null) {
      this.#delete.run('previewSettleMs')
      return
    }
    this.#set.run('previewSettleMs', String(clampSettleMs(ms)))
  }

  /** Whether a capture should render the selected agent's isolated worktree
   * (its branch) via a harness-run dev server, instead of the main checkout.
   * Off by default. */
  worktreePreview(): boolean {
    return (this.#get.get('worktreePreview') as { value: string } | undefined)?.value === '1'
  }

  setWorktreePreview(on: boolean): void {
    if (on) {
      this.#set.run('worktreePreview', '1')
    } else {
      this.#delete.run('worktreePreview')
    }
  }

  /** The command the harness runs to start the app's dev server inside a
   * worktree (e.g. `npm run dev`). */
  previewServerCommand(): string {
    return (
      (this.#get.get('previewServerCommand') as { value: string } | undefined)?.value ??
      DEFAULT_SERVER_COMMAND
    )
  }

  setPreviewServerCommand(command: string | null): void {
    const trimmed = command?.trim() ?? ''
    if (trimmed === '') {
      this.#delete.run('previewServerCommand')
    } else {
      this.#set.run('previewServerCommand', trimmed)
    }
  }

  /** The component-workbench target: the app root (to write the entry into), the
   * component file (root-relative), and an optional wrapper file that provides
   * app context. Undefined when no component is pinned — the preview then shows
   * the whole app / sample. */
  component(): { root: string; file: string; wrapper?: string; props?: string } | undefined {
    const root = (this.#get.get('componentRoot') as { value: string } | undefined)?.value
    const file = (this.#get.get('componentFile') as { value: string } | undefined)?.value
    if (root === undefined || file === undefined) {
      return undefined
    }
    const wrapper = (this.#get.get('componentWrapper') as { value: string } | undefined)?.value
    const props = (this.#get.get('componentProps') as { value: string } | undefined)?.value
    return {
      root,
      file,
      ...(wrapper === undefined ? {} : { wrapper }),
      ...(props === undefined ? {} : { props }),
    }
  }

  setComponent(
    root: string,
    file: string | null,
    wrapper?: string | null,
    props?: string | null,
  ): void {
    const trimmedFile = file?.trim() ?? ''
    const trimmedRoot = root.trim()
    if (trimmedFile === '' || trimmedRoot === '') {
      this.#delete.run('componentRoot')
      this.#delete.run('componentFile')
      this.#delete.run('componentWrapper')
      this.#delete.run('componentProps')
      return
    }
    this.#set.run('componentRoot', trimmedRoot)
    this.#set.run('componentFile', trimmedFile)
    this.#setOrClear('componentWrapper', wrapper)
    this.#setOrClear('componentProps', props)
  }

  #setOrClear(key: string, value: string | null | undefined): void {
    const trimmed = value?.trim() ?? ''
    if (trimmed === '') {
      this.#delete.run(key)
    } else {
      this.#set.run(key, trimmed)
    }
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
