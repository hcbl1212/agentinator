import { DatabaseSync, StatementSync } from 'node:sqlite'

import type { AgentType } from '../shared/agentTypes'
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

  /** Whether a capture of this agent should render its isolated worktree (its
   * branch) via a harness-run dev server, instead of the main checkout.
   * Per-session so each agent keeps its own choice. Off by default. */
  worktreePreview(sessionId: string): boolean {
    return (
      (this.#get.get(`worktreePreview:${sessionId}`) as { value: string } | undefined)?.value ===
      '1'
    )
  }

  setWorktreePreview(sessionId: string, on: boolean): void {
    const key = `worktreePreview:${sessionId}`
    if (on) {
      this.#set.run(key, '1')
    } else {
      this.#delete.run(key)
    }
  }

  /** The command the harness runs to start this agent's dev server inside its
   * worktree (e.g. `npm run dev`). Per-session, defaulting when unset. */
  previewServerCommand(sessionId: string): string {
    return (
      (this.#get.get(`previewServerCommand:${sessionId}`) as { value: string } | undefined)
        ?.value ?? DEFAULT_SERVER_COMMAND
    )
  }

  setPreviewServerCommand(sessionId: string, command: string | null): void {
    const key = `previewServerCommand:${sessionId}`
    const trimmed = command?.trim() ?? ''
    if (trimmed === '') {
      this.#delete.run(key)
    } else {
      this.#set.run(key, trimmed)
    }
  }

  /** The component-workbench target for one agent: the app root (to write the
   * entry into), the component file (root-relative), and an optional wrapper
   * file that provides app context. Per-session so a new agent starts blank
   * rather than inheriting whatever the last agent pinned. Undefined when this
   * session has nothing pinned — the preview then shows the whole app / sample. */
  component(
    sessionId: string,
  ): { root: string; file: string; wrapper?: string; props?: string } | undefined {
    const row = this.#get.get(`component:${sessionId}`) as { value: string } | undefined
    if (row === undefined) {
      return undefined
    }
    return JSON.parse(row.value) as { root: string; file: string; wrapper?: string; props?: string }
  }

  setComponent(
    sessionId: string,
    root: string,
    file: string | null,
    wrapper?: string | null,
    props?: string | null,
  ): void {
    const key = `component:${sessionId}`
    const trimmedFile = file?.trim() ?? ''
    const trimmedRoot = root.trim()
    if (trimmedFile === '' || trimmedRoot === '') {
      this.#delete.run(key)
      return
    }
    const value: { root: string; file: string; wrapper?: string; props?: string } = {
      root: trimmedRoot,
      file: trimmedFile,
    }
    const trimmedWrapper = wrapper?.trim() ?? ''
    if (trimmedWrapper !== '') {
      value.wrapper = trimmedWrapper
    }
    const trimmedProps = props?.trim() ?? ''
    if (trimmedProps !== '') {
      value.props = trimmedProps
    }
    this.#set.run(key, JSON.stringify(value))
  }

  /** The saved agent-type presets, in insertion order. Empty until the user
   * creates one. */
  agentTypes(): AgentType[] {
    const row = this.#get.get('agentTypes') as { value: string } | undefined
    return row === undefined ? [] : (JSON.parse(row.value) as AgentType[])
  }

  /** Create or update an agent type (upsert by id); a re-saved type moves to
   * the end of the list. */
  saveAgentType(type: AgentType): void {
    const list = this.agentTypes().filter((existing) => existing.id !== type.id)
    list.push(type)
    this.#set.run('agentTypes', JSON.stringify(list))
  }

  /** Delete an agent type by id (a no-op if it doesn't exist). */
  removeAgentType(id: string): void {
    this.#set.run('agentTypes', JSON.stringify(this.agentTypes().filter((type) => type.id !== id)))
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
