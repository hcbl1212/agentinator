import { contextBridge, ipcRenderer } from 'electron'

import type { AgentinatorBridge, PendingApproval } from '../shared/bridge'
import type { StoredEvent } from '../shared/events'

export const bridge: AgentinatorBridge = {
  events: {
    count: () => ipcRenderer.invoke('events:count') as Promise<number>,
    totalCost: () => ipcRenderer.invoke('events:total-cost') as Promise<number>,
    diffs: (sessionId) => ipcRenderer.invoke('events:diffs', sessionId) as Promise<StoredEvent[]>,
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
    startTask: (prompt, images, agentTypeId) =>
      ipcRenderer.invoke('agent:start-task', prompt, images, agentTypeId) as Promise<string>,
    send: (sessionId, text, images) =>
      ipcRenderer.invoke('agent:send', sessionId, text, images) as Promise<void>,
    cancel: (sessionId) => ipcRenderer.invoke('agent:cancel', sessionId) as Promise<void>,
    dismiss: (sessionId) => ipcRenderer.invoke('agent:dismiss', sessionId) as Promise<void>,
    switchToApiKey: (sessionId) =>
      ipcRenderer.invoke('agent:switch-credential', sessionId) as Promise<void>,
    switchToSubscription: (sessionId) =>
      ipcRenderer.invoke('agent:switch-subscription', sessionId) as Promise<void>,
  },
  credentials: {
    set: (providerId, key, persist) =>
      ipcRenderer.invoke('credentials:set', providerId, key, persist) as Promise<void>,
    has: (providerId) => ipcRenderer.invoke('credentials:has', providerId) as Promise<boolean>,
    clear: (providerId) => ipcRenderer.invoke('credentials:clear', providerId) as Promise<void>,
  },
  settings: {
    getBudgets: () =>
      ipcRenderer.invoke('settings:get-budgets') as Promise<import('../shared/budget').Budgets>,
    setBudget: (scope, usd) =>
      ipcRenderer.invoke('settings:set-budget', scope, usd) as Promise<void>,
    getApiKeyMode: () => ipcRenderer.invoke('settings:get-api-key-mode') as Promise<boolean>,
    setApiKeyMode: (on) => ipcRenderer.invoke('settings:set-api-key-mode', on) as Promise<void>,
    getPreviewTarget: () =>
      ipcRenderer.invoke('settings:get-preview-target') as Promise<string | null>,
    setPreviewTarget: (url) =>
      ipcRenderer.invoke('settings:set-preview-target', url) as Promise<void>,
    getPreviewSettleMs: () =>
      ipcRenderer.invoke('settings:get-preview-settle-ms') as Promise<number>,
    setPreviewSettleMs: (ms) =>
      ipcRenderer.invoke('settings:set-preview-settle-ms', ms) as Promise<void>,
    getWorktreePreview: (sessionId) =>
      ipcRenderer.invoke('settings:get-worktree-preview', sessionId) as Promise<boolean>,
    setWorktreePreview: (sessionId, on) =>
      ipcRenderer.invoke('settings:set-worktree-preview', sessionId, on) as Promise<void>,
    getPreviewServerCommand: (sessionId) =>
      ipcRenderer.invoke('settings:get-preview-server-command', sessionId) as Promise<string>,
    setPreviewServerCommand: (sessionId, command) =>
      ipcRenderer.invoke(
        'settings:set-preview-server-command',
        sessionId,
        command,
      ) as Promise<void>,
  },
  preview: {
    capture: (sessionId, url) =>
      ipcRenderer.invoke('preview:capture', sessionId, url) as Promise<string>,
    image: (ref) => ipcRenderer.invoke('preview:image', ref) as Promise<string | null>,
    getComponent: (sessionId) =>
      ipcRenderer.invoke('preview:get-component', sessionId) as Promise<{
        root: string
        file: string
        wrapper?: string
        props?: string
      } | null>,
    setComponent: (sessionId, root, file, wrapper, props) =>
      ipcRenderer.invoke(
        'preview:set-component',
        sessionId,
        root,
        file,
        wrapper,
        props,
      ) as Promise<void>,
    inferProps: (root, file) =>
      ipcRenderer.invoke('preview:infer-props', root, file) as Promise<string>,
    inferWrapper: (root, file) =>
      ipcRenderer.invoke('preview:infer-wrapper', root, file) as Promise<string>,
    chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder') as Promise<string | null>,
    chooseFile: (base) => ipcRenderer.invoke('dialog:choose-file', base) as Promise<string | null>,
    startWorktreeServer: (sessionId) =>
      ipcRenderer.invoke('preview:start-worktree-server', sessionId) as Promise<{
        url: string
      } | null>,
    stopWorktreeServers: () => ipcRenderer.invoke('preview:stop-worktree-servers') as Promise<void>,
    worktreeServerCount: () =>
      ipcRenderer.invoke('preview:worktree-server-count') as Promise<number>,
    worktreeDepsChanged: (sessionId) =>
      ipcRenderer.invoke('preview:worktree-deps-changed', sessionId) as Promise<boolean>,
  },
  approvals: {
    pending: () => ipcRenderer.invoke('approvals:pending') as Promise<PendingApproval[]>,
    resolve: (requestId, approved) =>
      ipcRenderer.invoke('approvals:resolve', requestId, approved) as Promise<void>,
    undo: (requestId) => ipcRenderer.invoke('approvals:undo', requestId) as Promise<void>,
  },
  worktrees: {
    summary: () =>
      ipcRenderer.invoke('worktrees:summary') as Promise<{ count: number; bytes: number }>,
    cleanup: () =>
      ipcRenderer.invoke('worktrees:cleanup') as Promise<{ count: number; bytes: number }>,
  },
  agentTypes: {
    list: () =>
      ipcRenderer.invoke('agent-types:list') as Promise<import('../shared/agentTypes').AgentType[]>,
    save: (type) => ipcRenderer.invoke('agent-types:save', type) as Promise<void>,
    remove: (id) => ipcRenderer.invoke('agent-types:remove', id) as Promise<void>,
  },
  queue: {
    add: (prompt) => ipcRenderer.invoke('queue:add', prompt) as Promise<string>,
    remove: (taskId) => ipcRenderer.invoke('queue:remove', taskId) as Promise<void>,
    dispatch: (taskId, prompt) =>
      ipcRenderer.invoke('queue:dispatch', taskId, prompt) as Promise<string>,
  },
  pipelines: {
    create: (prompt) => ipcRenderer.invoke('pipelines:create', prompt) as Promise<string>,
    continue: (pipelineId, fromSessionId) =>
      ipcRenderer.invoke('pipelines:continue', pipelineId, fromSessionId) as Promise<void>,
    revise: (pipelineId, fromSessionId, feedback) =>
      ipcRenderer.invoke('pipelines:revise', pipelineId, fromSessionId, feedback) as Promise<void>,
    approve: (pipelineId) => ipcRenderer.invoke('pipelines:approve', pipelineId) as Promise<void>,
    remove: (pipelineId) => ipcRenderer.invoke('pipelines:remove', pipelineId) as Promise<void>,
  },
  checkpoints: {
    create: (sessionId, label) =>
      ipcRenderer.invoke('checkpoints:create', sessionId, label) as Promise<string | null>,
    restore: (sessionId, checkpointId, sha) =>
      ipcRenderer.invoke('checkpoints:restore', sessionId, checkpointId, sha) as Promise<boolean>,
  },
}

contextBridge.exposeInMainWorld('agentinator', bridge)
