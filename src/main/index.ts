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

export function handleActivate(): void {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
}

export function handleWindowAllClosed(
  quit: () => void,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'darwin') {
    quit()
  }
}

export async function bootstrap(electronApp = app): Promise<void> {
  await electronApp.whenReady()
  createWindow()
  electronApp.on('activate', handleActivate)
  electronApp.on('window-all-closed', () => {
    handleWindowAllClosed(() => electronApp.quit())
  })
}

void bootstrap()
