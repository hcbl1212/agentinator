import { join } from 'node:path'

import { app, BrowserWindow, shell } from 'electron'

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
      sandbox: true,
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

export async function bootstrap(electronApp = app): Promise<void> {
  await electronApp.whenReady()
  createWindow()
  // Quit on last window close on every platform, including macOS. The harness
  // has no background work yet, so a closed window leaving the process (and
  // `npm run dev`) alive is a trap. Revisit as a tray/dock mode once agents
  // run in the main process and must outlive the window.
  electronApp.on('window-all-closed', () => {
    electronApp.quit()
  })
}

void bootstrap()
