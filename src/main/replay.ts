import { readFileSync } from 'node:fs'

import type { EventPayloads, EventType, StoredEvent } from '../shared/events'
import type { EventStore } from './eventStore'

/**
 * Replay mode: stream a recorded fixture through the real store and the real
 * broadcast channel, so the full UI renders a session with zero API spend.
 * Launch with AGENTINATOR_REPLAY=<fixture.json> (see npm run replay:demo).
 */
export type ReplayEntry = {
  [T in EventType]: { type: T; payload: EventPayloads[T] }
}[EventType]

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export async function replayFixture(
  path: string,
  store: EventStore,
  broadcast: (event: StoredEvent) => void,
  options: {
    sleep?: (ms: number) => Promise<void>
    read?: (path: string) => string
    stepMs?: number
  } = {},
): Promise<void> {
  const { sleep = defaultSleep, read = (p) => readFileSync(p, 'utf8'), stepMs = 200 } = options
  const entries = JSON.parse(read(path)) as ReplayEntry[]
  for (const entry of entries) {
    await sleep(stepMs)
    broadcast(store.append(entry.type, entry.payload))
  }
}
