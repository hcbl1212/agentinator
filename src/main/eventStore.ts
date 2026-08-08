import { DatabaseSync } from 'node:sqlite'

import type { EventPayloads, EventType, StoredEvent } from '../shared/events'

/**
 * The append-only event log — the single source of truth every view renders
 * from. Strictly INSERT-only: there is no update or delete API, and there
 * never will be. Uses node:sqlite (built into both Electron's Node and the
 * test runtime) so no native rebuilds are needed.
 */
export class EventStore {
  #db: DatabaseSync

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `)
  }

  append<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent<T> {
    const ts = new Date().toISOString()
    const result = this.#db
      .prepare('INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)')
      .run(ts, type, JSON.stringify(payload))
    return { seq: Number(result.lastInsertRowid), ts, type, payload }
  }

  list(afterSeq = 0): StoredEvent[] {
    const rows = this.#db
      .prepare('SELECT seq, ts, type, payload FROM events WHERE seq > ? ORDER BY seq')
      .all(afterSeq) as Array<{ seq: number; ts: string; type: EventType; payload: string }>
    return rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      type: row.type,
      payload: JSON.parse(row.payload) as StoredEvent['payload'],
    }))
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    return row.n
  }

  close(): void {
    this.#db.close()
  }
}
