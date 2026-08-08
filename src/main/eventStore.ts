import { DatabaseSync } from 'node:sqlite'

import type { EventPayloads, EventType, StoredEvent } from '../shared/events'

interface EventRow {
  seq: number
  ts: string
  type: EventType
  payload: string
}

/**
 * The append-only event log — the single source of truth every view renders
 * from. Strictly INSERT-only: there is no update or delete API for events,
 * and there never will be. Uses node:sqlite (built into both Electron's Node
 * and the test runtime) so no native rebuilds are needed.
 *
 * session_id is a derived, indexed column extracted from the payload at
 * append time so session-scoped queries stay cheap as the log grows.
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
        payload TEXT NOT NULL,
        session_id TEXT
      )
    `)
    const columns = this.#db
      .prepare("SELECT name FROM pragma_table_info('events')")
      .all() as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'session_id')) {
      this.#db.exec('ALTER TABLE events ADD COLUMN session_id TEXT')
      // One-time backfill of a DERIVED column from immutable payloads. The
      // events themselves (seq, ts, type, payload) are never mutated — this
      // materializes what the payload already says, for indexing only.
      this.#db.exec("UPDATE events SET session_id = json_extract(payload, '$.sessionId')")
    }
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id)')
  }

  append<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent<T> {
    const ts = new Date().toISOString()
    const sessionId = (payload as { sessionId?: unknown }).sessionId
    const result = this.#db
      .prepare('INSERT INTO events (ts, type, payload, session_id) VALUES (?, ?, ?, ?)')
      .run(ts, type, JSON.stringify(payload), typeof sessionId === 'string' ? sessionId : null)
    return { seq: Number(result.lastInsertRowid), ts, type, payload }
  }

  list(afterSeq = 0): StoredEvent[] {
    const rows = this.#db
      .prepare('SELECT seq, ts, type, payload FROM events WHERE seq > ? ORDER BY seq')
      .all(afterSeq) as unknown as EventRow[]
    return rows.map((row) => this.#toEvent(row))
  }

  /**
   * The newest `limit` events, oldest-first — or, with `beforeSeq`, the page
   * of `limit` events immediately preceding it (scrollback pagination).
   */
  tail(limit: number, beforeSeq?: number): StoredEvent[] {
    const rows = (beforeSeq === undefined
      ? this.#db
          .prepare('SELECT seq, ts, type, payload FROM events ORDER BY seq DESC LIMIT ?')
          .all(limit)
      : this.#db
          .prepare(
            'SELECT seq, ts, type, payload FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?',
          )
          .all(beforeSeq, limit)) as unknown as EventRow[]
    return rows.reverse().map((row) => this.#toEvent(row))
  }

  /** Every event of one session, oldest-first — served by the session index. */
  listBySession(sessionId: string): StoredEvent[] {
    const rows = this.#db
      .prepare('SELECT seq, ts, type, payload FROM events WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as unknown as EventRow[]
    return rows.map((row) => this.#toEvent(row))
  }

  /**
   * Case-insensitive substring search over type and raw payload across the
   * WHOLE log, newest matches first (returned oldest-first, capped at limit).
   */
  search(query: string, limit: number): StoredEvent[] {
    const like = `%${query}%`
    const rows = this.#db
      .prepare(
        'SELECT seq, ts, type, payload FROM events WHERE type LIKE ? OR payload LIKE ? ORDER BY seq DESC LIMIT ?',
      )
      .all(like, like, limit) as unknown as EventRow[]
    return rows.reverse().map((row) => this.#toEvent(row))
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    return row.n
  }

  close(): void {
    this.#db.close()
  }

  #toEvent(row: EventRow): StoredEvent {
    return {
      seq: row.seq,
      ts: row.ts,
      type: row.type,
      payload: JSON.parse(row.payload) as StoredEvent['payload'],
    }
  }
}
