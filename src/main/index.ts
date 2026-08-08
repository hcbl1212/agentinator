import { join } from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, ipcMain, shell } from 'electron'

import type { StoredEvent } from '../shared/events'
import { EventStore } from './eventStore'
import { createClaudeProvider } from './providers/claude'
import type { ClaudeQuery } from './providers/claude'
import { createMockProvider } from './providers/mock'
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
  handle('events:list', (_event, afterSeq) => store.list(afterSeq as number))
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
  handle('agent:cancel', (_event, sessionId) => manager.cancel(sessionId as string))
}

export function broadcastEvent(event: StoredEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('events:appended', event)
  }
}

export async function bootstrap(
  electronApp = app,
  createStore: (dbPath: string) => EventStore = (dbPath) => new EventStore(dbPath),
  claudeQuery: ClaudeQuery = query as unknown as ClaudeQuery,
): Promise<EventStore> {
  await electronApp.whenReady()

  const store = createStore(join(electronApp.getPath('userData'), 'agentinator.db'))
  store.append('app.started', { version: electronApp.getVersion() })
  registerEventIpc(store)

  const manager = new SessionManager(store, broadcastEvent)
  manager.register(createMockProvider())
  manager.register(createClaudeProvider(claudeQuery))
  registerAgentIpc(manager)

  createWindow()
  // Quit on last window close on every platform, including macOS. The harness
  // has no background work yet, so a closed window leaving the process (and
  // `npm run dev`) alive is a trap. Revisit as a tray/dock mode once agents
  // run in the main process and must outlive the window.
  electronApp.on('window-all-closed', () => {
    electronApp.quit()
  })

  return store
}
