import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTLE_MS, MAX_SETTLE_MS } from '../shared/preview'
import { SettingsStore } from './settingsStore'

const stores: SettingsStore[] = []
const tmpDirs: string[] = []

function open(path?: string): SettingsStore {
  const store = new SettingsStore(path)
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close()
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('SettingsStore', () => {
  it('defaults the session cap to $5 and leaves time windows uncapped', () => {
    expect(open().budgets()).toEqual({
      session: 5,
      hour: null,
      day: null,
      week: null,
      month: null,
    })
  })

  it('stores and reads back per-scope caps', () => {
    const store = open()

    store.setBudget('session', 12.5)
    store.setBudget('day', 20)
    store.setBudget('month', 200)

    expect(store.budgets()).toEqual({
      session: 12.5,
      hour: null,
      day: 20,
      week: null,
      month: 200,
    })
  })

  it('clears a window cap with null, and resets the session cap to the floor', () => {
    const store = open()
    store.setBudget('day', 20)
    store.setBudget('session', 30)

    store.setBudget('day', null)
    store.setBudget('session', null)

    const budgets = store.budgets()
    expect(budgets.day).toBeNull()
    expect(budgets.session).toBe(5)
  })

  it('treats a non-positive cap as clearing it', () => {
    const store = open()
    store.setBudget('week', 10)

    store.setBudget('week', 0)
    expect(store.budgets().week).toBeNull()

    store.setBudget('week', Number.NaN)
    expect(store.budgets().week).toBeNull()
  })

  it('ignores a corrupted (hand-edited) cap value in the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-settings-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'settings.db')

    const raw = new DatabaseSync(dbPath)
    raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    raw
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('budget.week', 'not-a-number')
    raw.close()

    expect(open(dbPath).budgets().week).toBeNull()
  })

  it('persists across close and reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-settings-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'settings.db')

    const first = new SettingsStore(dbPath)
    first.setBudget('month', 150)
    first.close()

    expect(open(dbPath).budgets().month).toBe(150)
  })

  it('keeps each agent’s pinned component across a reopen (restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-settings-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'settings.db')

    const first = new SettingsStore(dbPath)
    first.setComponent('session_abc', '/app', 'src/Cart.tsx', 'src/Wrap.tsx', '{ n: 1 }')
    first.close()

    // A fresh store over the same file (a restart) still has that agent's pin,
    // and only that agent's — a different session stays blank.
    const reopened = open(dbPath)
    expect(reopened.component('session_abc')).toEqual({
      root: '/app',
      file: 'src/Cart.tsx',
      wrapper: 'src/Wrap.tsx',
      props: '{ n: 1 }',
    })
    expect(reopened.component('session_other')).toBeUndefined()
  })

  it('persists the run-on-API-key toggle, defaulting off', () => {
    const store = new SettingsStore()

    expect(store.apiKeyMode()).toBe(false)
    store.setApiKeyMode(true)
    expect(store.apiKeyMode()).toBe(true)
    store.setApiKeyMode(false)
    expect(store.apiKeyMode()).toBe(false)
    store.close()
  })

  it('persists the preview target, trimming and clearing on empty', () => {
    const store = new SettingsStore()

    expect(store.previewTarget()).toBeUndefined()
    store.setPreviewTarget('  http://localhost:3001/  ')
    expect(store.previewTarget()).toBe('http://localhost:3001/')
    store.setPreviewTarget('   ')
    expect(store.previewTarget()).toBeUndefined()
    store.setPreviewTarget('http://localhost:3001/')
    store.setPreviewTarget(null)
    expect(store.previewTarget()).toBeUndefined()
    store.close()
  })

  it('persists the preview settle delay, defaulting and clamping', () => {
    const store = new SettingsStore()

    // Default until set.
    expect(store.previewSettleMs()).toBe(DEFAULT_SETTLE_MS)
    store.setPreviewSettleMs(900)
    expect(store.previewSettleMs()).toBe(900)
    // Out-of-range is clamped on write.
    store.setPreviewSettleMs(MAX_SETTLE_MS + 1000)
    expect(store.previewSettleMs()).toBe(MAX_SETTLE_MS)
    // Null clears back to the default.
    store.setPreviewSettleMs(null)
    expect(store.previewSettleMs()).toBe(DEFAULT_SETTLE_MS)
    store.close()
  })

  it('toggles worktree preview and persists the dev-server command per session', () => {
    const store = new SettingsStore()

    expect(store.worktreePreview('s1')).toBe(false)
    store.setWorktreePreview('s1', true)
    expect(store.worktreePreview('s1')).toBe(true)
    // Each agent keeps its own toggle — turning s1 on doesn't affect s2.
    expect(store.worktreePreview('s2')).toBe(false)
    store.setWorktreePreview('s1', false)
    expect(store.worktreePreview('s1')).toBe(false)

    // Defaults to Vite's dev script; trims; blank clears back to default.
    expect(store.previewServerCommand('s1')).toBe('npm run dev')
    store.setPreviewServerCommand('s1', '  pnpm dev  ')
    expect(store.previewServerCommand('s1')).toBe('pnpm dev')
    expect(store.previewServerCommand('s2')).toBe('npm run dev') // s2 unaffected
    store.setPreviewServerCommand('s1', 'vite')
    store.setPreviewServerCommand('s1', null) // null clears too
    expect(store.previewServerCommand('s1')).toBe('npm run dev')
    store.close()
  })

  it('persists a per-session component-workbench target incl. an optional wrapper', () => {
    const store = new SettingsStore()

    expect(store.component('s1')).toBeUndefined()
    store.setComponent('s1', '  /app  ', '  src/Cart.tsx  ')
    expect(store.component('s1')).toEqual({ root: '/app', file: 'src/Cart.tsx' })

    // A wrapper and props are stored alongside and returned.
    store.setComponent('s1', '/app', 'src/Cart.tsx', '  src/PreviewProviders.tsx  ', '  { a: 1 }  ')
    expect(store.component('s1')).toEqual({
      root: '/app',
      file: 'src/Cart.tsx',
      wrapper: 'src/PreviewProviders.tsx',
      props: '{ a: 1 }',
    })
    // Re-pinning without a wrapper or props drops them.
    store.setComponent('s1', '/app', 'src/Cart.tsx', '  ')
    expect(store.component('s1')).toEqual({ root: '/app', file: 'src/Cart.tsx' })

    // Each session's pin is independent — another agent starts blank.
    expect(store.component('s2')).toBeUndefined()
    store.setComponent('s2', '/other', 'src/Other.tsx')
    expect(store.component('s2')).toEqual({ root: '/other', file: 'src/Other.tsx' })
    expect(store.component('s1')).toEqual({ root: '/app', file: 'src/Cart.tsx' })

    // Clearing the file clears the whole target (wrapper included).
    store.setComponent('s1', '/app', 'src/Cart.tsx', 'src/PreviewProviders.tsx')
    store.setComponent('s1', '/app', null)
    expect(store.component('s1')).toBeUndefined()
    // A blank root also clears it.
    store.setComponent('s1', '/app', 'src/Cart.tsx')
    store.setComponent('s1', '   ', 'src/Cart.tsx')
    expect(store.component('s1')).toBeUndefined()
    store.close()
  })

  it('saves (upsert), lists, and removes agent-type presets', () => {
    const store = new SettingsStore()

    expect(store.agentTypes()).toEqual([])
    store.saveAgentType({ id: 'a', name: 'Reviewer', instructions: 'review only', readOnly: true })
    store.saveAgentType({ id: 'b', name: 'Tester', instructions: 'write tests', model: 'm' })
    expect(store.agentTypes()).toEqual([
      { id: 'a', name: 'Reviewer', instructions: 'review only', readOnly: true },
      { id: 'b', name: 'Tester', instructions: 'write tests', model: 'm' },
    ])

    // Re-saving by id upserts and moves the type to the end.
    store.saveAgentType({ id: 'a', name: 'Reviewer v2', instructions: 'r2' })
    expect(store.agentTypes().map((type) => type.name)).toEqual(['Tester', 'Reviewer v2'])

    store.removeAgentType('b')
    expect(store.agentTypes().map((type) => type.id)).toEqual(['a'])
    store.close()
  })

  it('stores, reads, lists, and deletes credential ciphertext', () => {
    const store = new SettingsStore()

    store.saveSecret('claude', 'cipher-a')
    store.saveSecret('openai', 'cipher-b')

    expect(store.readSecret('claude')).toBe('cipher-a')
    expect(
      store
        .secrets()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['claude', 'openai'])
    expect(store.readSecret('missing')).toBeUndefined()

    store.deleteSecret('claude')
    expect(store.readSecret('claude')).toBeUndefined()
    expect(store.secrets()).toEqual([{ id: 'openai', ciphertext: 'cipher-b' }])
    store.close()
  })
})
