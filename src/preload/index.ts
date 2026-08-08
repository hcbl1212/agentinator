import { contextBridge, ipcRenderer } from 'electron'

import type { AgentinatorBridge } from '../shared/bridge'
import type { StoredEvent } from '../shared/events'

export const bridge: AgentinatorBridge = {
  events: {
    count: () => ipcRenderer.invoke('events:count') as Promise<number>,
    list: (afterSeq = 0) => ipcRenderer.invoke('events:list', afterSeq) as Promise<StoredEvent[]>,
  },
}

contextBridge.exposeInMainWorld('agentinator', bridge)
