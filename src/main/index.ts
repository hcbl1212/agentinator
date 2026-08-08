import { join } from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, ipcMain, shell } from 'electron'

import type { BudgetScope } from '../shared/budget'
import type { StoredEvent } from '../shared/events'
import { PermissionBroker } from './approvals'
import type { EmitStored } from './approvals'
import { EventStore } from './eventStore'
import { SettingsStore } from './settingsStore'
import { createClaudeProvider } from './providers/claude'
import type { ClaudeQuery } from './providers/claude'
import { createMockProvider } from './providers/mock'
import { replayFixture } from './replay'
import { SessionManager } from './sessions'

export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Agentinator',
    backgroundColor: '#101614',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(import.meta.dirname, '../preload/index.mjs'),
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl === undefined) {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  } else {
    void window.loadURL(rendererUrl)
  }

  return window
}

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

export function registerEventIpc(
  store: EventStore,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('events:count', () => store.count())
  handle('events:total-cost', () => store.totalCostUsd())
  handle('events:diffs', () => store.latestDiffs())
  handle('events:list', (_event, afterSeq) => store.list(afterSeq as number))
  handle('events:tail', (_event, limit, beforeSeq) =>
    store.tail(limit as number, beforeSeq as number | undefined),
  )
  handle('events:search', (_event, query, limit) => store.search(query as string, limit as number))
}

export function registerAgentIpc(
  manager: SessionManager,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('agent:start-demo', () =>
    manager.start({
      providerId: 'mock',
      title: 'Demo: greet util',
      prompt: 'Add a greet util with a test.',
      cwd: process.cwd(),
    }),
  )
  handle('agent:start-task', (_event, prompt) =>
    manager.start({
      providerId: 'claude',
      title: taskTitle(prompt as string),
      prompt: prompt as string,
      // The workspace repo — for now the process cwd (the repo when run via
      // `npm run dev`); explicit workspace/dir selection arrives in Phase 5.
      cwd: process.cwd(),
    }),
  )
  handle('agent:cancel', (_event, sessionId) => manager.cancel(sessionId as string))
}

/** A short one-line title from a task prompt for the roster and timeline. */
export function taskTitle(prompt: string): string {
  // split() always yields at least one element, so [0] is defined.
  const firstLine = prompt.trim().split('\n')[0]
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine
}

export function registerSettingsIpc(
  settings: SettingsStore,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('settings:get-budgets', () => settings.budgets())
  handle('settings:set-budget', (_event, scope, usd) => {
    settings.setBudget(scope as BudgetScope, usd as number | null)
  })
}

export function registerApprovalIpc(
  broker: PermissionBroker,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('approvals:pending', () => broker.pending())
  handle('approvals:resolve', (_event, requestId, approved) => {
    broker.resolve(requestId as string, approved as boolean)
  })
  handle('approvals:undo', (_event, requestId) => {
    broker.undo(requestId as string)
  })
}

export function broadcastEvent(event: StoredEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('events:appended', event)
  }
}

/** Append + broadcast in one call — the broker's audit channel into the log. */
export function makeEmitStored(store: EventStore, broadcast = broadcastEvent): EmitStored {
  return (type, payload) => {
    const stored = store.append(type, payload)
    broadcast(stored)
    return stored
  }
}

export async function bootstrap(
  electronApp = app,
  createStore: (dbPath: string) => EventStore = (dbPath) => new EventStore(dbPath),
  claudeQuery: ClaudeQuery = query as unknown as ClaudeQuery,
  env: Record<string, string | undefined> = process.env,
  replay: typeof replayFixture = replayFixture,
  createSettings: (dbPath: string) => SettingsStore = (dbPath) => new SettingsStore(dbPath),
): Promise<EventStore> {
  await electronApp.whenReady()

  // Replay mode reviews UI against a recorded session with zero API spend —
  // an in-memory store keeps fixtures out of the real event log.
  const replayPath = env['AGENTINATOR_REPLAY']
  const inMemory = replayPath !== undefined
  const userData = electronApp.getPath('userData')
  const store = createStore(inMemory ? ':memory:' : join(userData, 'agentinator.db'))
  const settings = createSettings(inMemory ? ':memory:' : join(userData, 'agentinator-settings.db'))
  store.append('app.started', { version: electronApp.getVersion() })
  registerEventIpc(store)
  registerSettingsIpc(settings)

  const broker = new PermissionBroker(makeEmitStored(store))
  const decide = broker.decide.bind(broker)

  const manager = new SessionManager(store, broadcastEvent, {
    getBudgets: () => settings.budgets(),
  })
  manager.register(createMockProvider(undefined, undefined, decide))
  manager.register(createClaudeProvider(claudeQuery, decide))
  registerAgentIpc(manager)
  registerApprovalIpc(broker)

  createWindow()
  if (replayPath !== undefined) {
    void replay(replayPath, store, broadcastEvent)
  }
  // Quit on last window close on every platform, including macOS. The harness
  // has no background work yet, so a closed window leaving the process (and
  // `npm run dev`) alive is a trap. Revisit as a tray/dock mode once agents
  // run in the main process and must outlive the window.
  electronApp.on('window-all-closed', () => {
    electronApp.quit()
  })

  return store
}
