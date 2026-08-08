import type { StoredEvent } from './events'

/**
 * The API the preload script exposes to the renderer as `window.agentinator`.
 * The renderer never touches Node or Electron directly — everything crosses
 * this typed bridge.
 */
export interface AgentinatorBridge {
  events: {
    count(): Promise<number>
    list(afterSeq?: number): Promise<StoredEvent[]>
  }
}
