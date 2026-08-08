import { DatabaseSync, StatementSync } from 'node:sqlite'

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
 * ## Performance & scaling ledger (measured at 100k events, M-series mac)
 *
 * In place now:
 * - WAL + synchronous=NORMAL: durable-enough journaling (WAL survives app
 *   crashes; NORMAL risks only power-loss rollback of the last commit) at
 *   ~12µs per insert vs ~53µs under FULL.
 * - Prepared statements cached once, not re-parsed per call.
 * - count() = MAX(seq): O(log n) and exactly correct because the log is
 *   append-only with an AUTOINCREMENT key (no deletes → no gaps reclaimed).
 * - seq is the time axis: it's monotonic, so range/scrubber queries bisect
 *   on the primary key — no ts index needed.
 * - session_id: derived, indexed at append (~2ms session reads @100k).
 *
 * Deliberately deferred, with the trigger that revisits each:
 * - search() is a LIKE table scan (~9ms @100k, linear). Swap the internals
 *   for FTS5 (contentless table fed in append()) when p95 search > ~50ms —
 *   roughly 500k events. The method signature won't change.
 * - No index on `type`: no query consumes one yet; every index taxes the
 *   write path. Add (type, seq) when the metrics slice aggregates by type.
 * - Metrics/aggregations must NOT re-reduce the log per render — build
 *   materialized projection tables updated on append (CQRS) when they land.
 * - Large payloads (diff patches) inline for now; offload to a blob table
 *   if median event size grows past a few KB.
 * - The file grows forever by design; at multi-GB, archive cold years into
 *   ATTACHed databases. Windowed reads mean UI latency stays flat regardless.
 */
export class EventStore {
  #db: DatabaseSync
  #insert: StatementSync
  #selectAfter: StatementSync
  #selectTail: StatementSync
  #selectBefore: StatementSync
  #selectBySession: StatementSync
  #selectSearch: StatementSync
  #selectMaxSeq: StatementSync
  #selectTotalCost: StatementSync

  constructor(path = ':memory:') {
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA synchronous = NORMAL')
    this.#db.exec('PRAGMA busy_timeout = 5000')
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

    this.#insert = this.#db.prepare(
      'INSERT INTO events (ts, type, payload, session_id) VALUES (?, ?, ?, ?)',
    )
    this.#selectAfter = this.#db.prepare(
      'SELECT seq, ts, type, payload FROM events WHERE seq > ? ORDER BY seq',
    )
    this.#selectTail = this.#db.prepare(
      'SELECT seq, ts, type, payload FROM events ORDER BY seq DESC LIMIT ?',
    )
    this.#selectBefore = this.#db.prepare(
      'SELECT seq, ts, type, payload FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?',
    )
    this.#selectBySession = this.#db.prepare(
      'SELECT seq, ts, type, payload FROM events WHERE session_id = ? ORDER BY seq',
    )
    this.#selectSearch = this.#db.prepare(
      'SELECT seq, ts, type, payload FROM events WHERE type LIKE ? OR payload LIKE ? ORDER BY seq DESC LIMIT ?',
    )
    this.#selectMaxSeq = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events')
    this.#selectTotalCost = this.#db.prepare(
      "SELECT COALESCE(SUM(json_extract(payload, '$.usd')), 0) AS usd FROM events WHERE type = 'cost.usage'",
    )
  }

  append<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent<T> {
    const ts = new Date().toISOString()
    const sessionId = (payload as { sessionId?: unknown }).sessionId
    const result = this.#insert.run(
      ts,
      type,
      JSON.stringify(payload),
      typeof sessionId === 'string' ? sessionId : null,
    )
    return { seq: Number(result.lastInsertRowid), ts, type, payload }
  }

  list(afterSeq = 0): StoredEvent[] {
    const rows = this.#selectAfter.all(afterSeq) as unknown as EventRow[]
    return rows.map((row) => this.#toEvent(row))
  }

  /**
   * The newest `limit` events, oldest-first — or, with `beforeSeq`, the page
   * of `limit` events immediately preceding it (scrollback pagination).
   */
  tail(limit: number, beforeSeq?: number): StoredEvent[] {
    const rows = (beforeSeq === undefined
      ? this.#selectTail.all(limit)
      : this.#selectBefore.all(beforeSeq, limit)) as unknown as EventRow[]
    return rows.reverse().map((row) => this.#toEvent(row))
  }

  /** Every event of one session, oldest-first — served by the session index. */
  listBySession(sessionId: string): StoredEvent[] {
    const rows = this.#selectBySession.all(sessionId) as unknown as EventRow[]
    return rows.map((row) => this.#toEvent(row))
  }

  /**
   * Case-insensitive substring search over type and raw payload across the
   * WHOLE log, newest matches first (returned oldest-first, capped at limit).
   */
  search(query: string, limit: number): StoredEvent[] {
    const like = `%${query}%`
    const rows = this.#selectSearch.all(like, like, limit) as unknown as EventRow[]
    return rows.reverse().map((row) => this.#toEvent(row))
  }

  count(): number {
    // MAX(seq) == COUNT(*) here: append-only, AUTOINCREMENT, never deleted.
    const row = this.#selectMaxSeq.get() as { n: number }
    return row.n
  }

  /** Lifetime spend across every session in the log. */
  totalCostUsd(): number {
    const row = this.#selectTotalCost.get() as { usd: number }
    return row.usd
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
