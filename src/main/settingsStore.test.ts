import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  it('defaults the budget to $5 when unset', () => {
    expect(open().budgetUsd()).toBe(5)
  })

  it('stores and reads back a budget', () => {
    const store = open()

    store.setBudgetUsd(12.5)

    expect(store.budgetUsd()).toBe(12.5)
  })

  it('upserts rather than duplicating on repeated writes', () => {
    const store = open()

    store.setBudgetUsd(3)
    store.setBudgetUsd(8)

    expect(store.budgetUsd()).toBe(8)
  })

  it('falls back to the default for a non-positive or non-numeric stored value', () => {
    const store = open()

    store.setBudgetUsd(0)
    expect(store.budgetUsd()).toBe(5)

    store.setBudgetUsd(Number.NaN)
    expect(store.budgetUsd()).toBe(5)
  })

  it('persists across close and reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-settings-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'settings.db')

    const first = new SettingsStore(dbPath)
    first.setBudgetUsd(20)
    first.close()

    expect(open(dbPath).budgetUsd()).toBe(20)
  })
})
