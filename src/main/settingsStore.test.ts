import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

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
})
