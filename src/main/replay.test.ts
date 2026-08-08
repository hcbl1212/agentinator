import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StoredEvent } from '../shared/events'
import { EventStore } from './eventStore'
import { replayFixture } from './replay'

const fixture = JSON.stringify([
  { type: 'agent.text', payload: { sessionId: 's', text: 'one' } },
  { type: 'agent.text', payload: { sessionId: 's', text: 'two' } },
])

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

describe('replayFixture', () => {
  it('appends each fixture entry to the store and broadcasts it, in order', async () => {
    const store = new EventStore()
    const broadcast: StoredEvent[] = []
    const sleep = vi.fn(() => Promise.resolve())

    await replayFixture('demo.json', store, (event) => broadcast.push(event), {
      sleep,
      read: (path) => {
        expect(path).toBe('demo.json')
        return fixture
      },
      stepMs: 5,
    })

    expect(store.count()).toBe(2)
    expect(broadcast.map((event) => event.seq)).toEqual([1, 2])
    expect(sleep).toHaveBeenCalledWith(5)
  })

  it('reads a real fixture file and paces with real timers by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-replay-'))
    tmpDirs.push(dir)
    const path = join(dir, 'fixture.json')
    writeFileSync(path, fixture)
    const store = new EventStore()
    const broadcast: StoredEvent[] = []

    vi.useFakeTimers()
    const replaying = replayFixture(path, store, (event) => broadcast.push(event))
    await vi.advanceTimersByTimeAsync(500)
    await replaying

    expect(broadcast).toHaveLength(2)
    expect(store.list()[1]?.payload).toMatchObject({ text: 'two' })
  })
})
