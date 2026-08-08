import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { EventStore } from './eventStore'

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

export async function bootstrap(
  electronApp = app,
  createStore: (dbPath: string) => EventStore = (dbPath) => new EventStore(dbPath),
): Promise<EventStore> {
  await electronApp.whenReady()

  const store = createStore(join(electronApp.getPath('userData'), 'agentinator.db'))
  store.append('app.started', { version: electronApp.getVersion() })
  registerEventIpc(store)

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

void bootstrap()
