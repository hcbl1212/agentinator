import { contextBridge, ipcRenderer } from 'electron'

import type { AgentinatorBridge, PendingApproval } from '../shared/bridge'
import type { StoredEvent } from '../shared/events'

export const bridge: AgentinatorBridge = {
  events: {
    count: () => ipcRenderer.invoke('events:count') as Promise<number>,
    totalCost: () => ipcRenderer.invoke('events:total-cost') as Promise<number>,
    diffs: () => ipcRenderer.invoke('events:diffs') as Promise<StoredEvent[]>,
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
    current: () =>
      ipcRenderer.invoke('agent:current') as Promise<import('../shared/bridge').AgentDescriptor>,
    startDemo: () => ipcRenderer.invoke('agent:start-demo') as Promise<string>,
    startTask: (prompt) => ipcRenderer.invoke('agent:start-task', prompt) as Promise<string>,
    send: (sessionId, text) => ipcRenderer.invoke('agent:send', sessionId, text) as Promise<void>,
    cancel: (sessionId) => ipcRenderer.invoke('agent:cancel', sessionId) as Promise<void>,
  },
  settings: {
    getBudgets: () =>
      ipcRenderer.invoke('settings:get-budgets') as Promise<import('../shared/budget').Budgets>,
    setBudget: (scope, usd) =>
      ipcRenderer.invoke('settings:set-budget', scope, usd) as Promise<void>,
  },
  approvals: {
    pending: () => ipcRenderer.invoke('approvals:pending') as Promise<PendingApproval[]>,
    resolve: (requestId, approved) =>
      ipcRenderer.invoke('approvals:resolve', requestId, approved) as Promise<void>,
    undo: (requestId) => ipcRenderer.invoke('approvals:undo', requestId) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('agentinator', bridge)
