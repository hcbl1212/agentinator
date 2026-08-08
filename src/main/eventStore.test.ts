import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('exposes no way to update or delete events', () => {
    const store = open()

    const mutators = Object.getOwnPropertyNames(EventStore.prototype).filter((name) =>
      /update|delete|remove|truncate|clear/i.test(name),
    )

    expect(mutators).toEqual([])
    expect(store.count()).toBe(0)
  })
})
