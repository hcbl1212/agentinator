import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { EventStore } from './eventStore'

const stores: EventStore[] = []
const tmpDirs: string[] = []

function open(path?: string): EventStore {
  const store = new EventStore(path)
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

describe('EventStore', () => {
  it('starts empty', () => {
    const store = open()

    expect(store.count()).toBe(0)
    expect(store.list()).toEqual([])
  })

  it('appends events with monotonically increasing sequence numbers', () => {
    const store = open()

    const first = store.append('app.started', { version: '0.1.0' })
    const second = store.append('agent.text', { sessionId: 'session_1', text: 'hello' })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(store.count()).toBe(2)
  })

  it('stamps events with an ISO-8601 timestamp', () => {
    const store = open()

    const event = store.append('app.started', { version: '0.1.0' })

    expect(new Date(event.ts).toISOString()).toBe(event.ts)
  })

  it('round-trips structured payloads through the log', () => {
    const store = open()
    const payload = {
      sessionId: 'session_1',
      callId: 'call_1',
      tool: 'bash',
      input: { command: 'npm test', nested: [1, 2, 3] },
    }

    store.append('tool.called', payload)

    expect(store.list()[0]?.payload).toEqual(payload)
  })

  it('lists events after a given sequence number, in order', () => {
    const store = open()
    store.append('app.started', { version: '0.1.0' })
    store.append('agent.text', { sessionId: 'session_1', text: 'one' })
    store.append('agent.text', { sessionId: 'session_1', text: 'two' })

    const tail = store.list(1)

    expect(tail.map((event) => event.seq)).toEqual([2, 3])
  })

  it('persists events across close and reopen when backed by a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-store-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'events.db')

    const first = new EventStore(dbPath)
    first.append('app.started', { version: '0.1.0' })
    first.close()

    const second = open(dbPath)

    expect(second.count()).toBe(1)
    expect(second.list()[0]?.type).toBe('app.started')
  })

  it('tails the newest events oldest-first, and pages backward from a cursor', () => {
    const store = open()
    store.append('app.started', { version: '0.1.0' })
    for (let i = 1; i <= 5; i += 1) {
      store.append('agent.text', { sessionId: 'session_1', text: `msg ${i}` })
    }

    const tail = store.tail(3)
    expect(tail.map((event) => event.seq)).toEqual([4, 5, 6])

    const earlier = store.tail(3, 4)
    expect(earlier.map((event) => event.seq)).toEqual([1, 2, 3])

    const start = store.tail(3, 1)
    expect(start).toEqual([])
  })

  it('lists a single session via the indexed session_id column', () => {
    const store = open()
    store.append('app.started', { version: '0.1.0' })
    store.append('agent.text', { sessionId: 'session_a', text: 'a1' })
    store.append('agent.text', { sessionId: 'session_b', text: 'b1' })
    store.append('agent.text', { sessionId: 'session_a', text: 'a2' })

    const events = store.listBySession('session_a')

    expect(events.map((event) => (event.payload as { text: string }).text)).toEqual(['a1', 'a2'])
  })

  it('migrates a pre-session_id database, backfilling the index from payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-store-'))
    tmpDirs.push(dir)
    const dbPath = join(dir, 'events.db')

    // Simulate a slice-1b-era database: no session_id column.
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `)
    legacy
      .prepare('INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)')
      .run('t1', 'agent.text', JSON.stringify({ sessionId: 'session_old', text: 'legacy' }))
    legacy.close()

    const store = open(dbPath)

    expect(store.count()).toBe(1)
    expect(store.listBySession('session_old')).toHaveLength(1)
    store.append('agent.text', { sessionId: 'session_old', text: 'fresh' })
    expect(store.listBySession('session_old')).toHaveLength(2)
  })

  it('searches the whole log by type and payload, case-insensitively, capped and ordered', () => {
    const store = open()
    store.append('app.started', { version: '0.1.0' })
    store.append('agent.text', { sessionId: 'session_1', text: 'Adding the GREET util' })
    store.append('agent.text', { sessionId: 'session_1', text: 'unrelated' })
    store.append('tool.called', { sessionId: 'session_1', callId: 'c', tool: 'bash', input: {} })

    expect(store.search('greet', 10).map((event) => event.seq)).toEqual([2])
    expect(store.search('tool.', 10).map((event) => event.seq)).toEqual([4])
    expect(store.search('session_1', 2).map((event) => event.seq)).toEqual([3, 4])
    expect(store.search('nothing-here', 10)).toEqual([])
  })

  it('sums lifetime spend across cost events, ignoring non-cost events', () => {
    const store = open()
    expect(store.totalCostUsd()).toBe(0)

    store.append('app.started', { version: '0.1.0' })
    store.append('cost.usage', {
      sessionId: 's',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      usd: 0.004,
    })
    store.append('cost.usage', {
      sessionId: 's',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      usd: 0.006,
    })

    expect(store.totalCostUsd()).toBeCloseTo(0.01, 10)
  })

  it('sums cost since a timestamp for time-windowed budgets', () => {
    const store = open()
    const before = store.append('cost.usage', {
      sessionId: 's',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      usd: 1,
    })
    const cutoff = store.append('cost.usage', {
      sessionId: 's',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      usd: 2,
    })

    // Since the cutoff event's own timestamp: includes it and nothing earlier.
    expect(store.costSinceUsd(cutoff.ts)).toBeGreaterThanOrEqual(2)
    expect(store.costSinceUsd(before.ts)).toBeCloseTo(3, 10)
    expect(store.costSinceUsd('2999-01-01T00:00:00.000Z')).toBe(0)
  })

  it('exposes no way to update or delete events', () => {
    const store = open()

    const mutators = Object.getOwnPropertyNames(EventStore.prototype).filter((name) =>
      /update|delete|remove|truncate|clear/i.test(name),
    )

    expect(mutators).toEqual([])
    expect(store.count()).toBe(0)
  })
})
