import { contextBridge, ipcRenderer } from 'electron'

import type { AgentinatorBridge, PendingApproval } from '../shared/bridge'
import type { StoredEvent } from '../shared/events'

export const bridge: AgentinatorBridge = {
  events: {
    count: () => ipcRenderer.invoke('events:count') as Promise<number>,
    totalCost: () => ipcRenderer.invoke('events:total-cost') as Promise<number>,
    list: (afterSeq = 0) => ipcRenderer.invoke('events:list', afterSeq) as Promise<StoredEvent[]>,
    tail: (limit, beforeSeq) =>
      ipcRenderer.invoke('events:tail', limit, beforeSeq) as Promise<StoredEvent[]>,
    search: (query, limit) =>
      ipcRenderer.invoke('events:search', query, limit) as Promise<StoredEvent[]>,
    onAppended: (listener) => {
      const wrapped = (_event: unknown, stored: StoredEvent): void => {
        listener(stored)
      }
      ipcRenderer.on('events:appended', wrapped)
      return () => {
        ipcRenderer.removeListener('events:appended', wrapped)
      }
    },
  },
  agent: {
    startDemo: () => ipcRenderer.invoke('agent:start-demo') as Promise<string>,
    cancel: (sessionId) => ipcRenderer.invoke('agent:cancel', sessionId) as Promise<void>,
  },
  settings: {
    getBudgetUsd: () => ipcRenderer.invoke('settings:get-budget') as Promise<number>,
    setBudgetUsd: (usd) => ipcRenderer.invoke('settings:set-budget', usd) as Promise<void>,
  },
  approvals: {
    pending: () => ipcRenderer.invoke('approvals:pending') as Promise<PendingApproval[]>,
    resolve: (requestId, approved) =>
      ipcRenderer.invoke('approvals:resolve', requestId, approved) as Promise<void>,
    undo: (requestId) => ipcRenderer.invoke('approvals:undo', requestId) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('agentinator', bridge)
