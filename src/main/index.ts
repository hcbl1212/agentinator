import { join } from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'

import type { BudgetScope } from '../shared/budget'
import type { EventPayloads, ImageAttachment, StoredEvent } from '../shared/events'
import { PermissionBroker } from './approvals'
import type { EmitStored } from './approvals'
import { CredentialVault } from './credentials'
import type { Encryptor } from './credentials'
import { EventStore } from './eventStore'
import { SettingsStore } from './settingsStore'
import { createClaudeProvider } from './providers/claude'
import type { ClaudeQuery } from './providers/claude'
import { createE2eProvider } from './providers/e2e'
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
  handle('events:diffs', (_event, sessionId) => store.latestDiffs(sessionId as string | undefined))
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
  // The provider a "Run task" uses. Swapping this (or making it user-selected)
  // is all it takes to point the UI at another vendor. The e2e sets
  // AGENTINATOR_MOCK_TASKS to drive the deterministic mock with no network.
  const taskProvider = process.env['AGENTINATOR_MOCK_TASKS'] === '1' ? 'e2e' : 'claude'
  handle(
    'agent:current',
    () =>
      manager.describeProvider(taskProvider) ?? {
        providerId: taskProvider,
        label: taskProvider,
      },
  )
  handle('agent:start-demo', () =>
    manager.start({
      providerId: 'mock',
      title: 'Demo: greet util',
      prompt: 'Add a greet util with a test.',
      cwd: process.cwd(),
    }),
  )
  handle('agent:start-task', (_event, prompt, images) =>
    manager.start({
      providerId: taskProvider,
      title: taskTitle(prompt as string),
      prompt: prompt as string,
      images: images as ImageAttachment[] | undefined,
      // The workspace repo — for now the process cwd (the repo when run via
      // `npm run dev`); explicit workspace/dir selection arrives in Phase 5.
      cwd: process.cwd(),
    }),
  )
  handle('agent:send', (_event, sessionId, text, images) =>
    manager.send(sessionId as string, text as string, images as ImageAttachment[] | undefined),
  )
  handle('agent:cancel', (_event, sessionId) => manager.cancel(sessionId as string))
  handle('agent:dismiss', (_event, sessionId) => manager.dismiss(sessionId as string))
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

/** The provider id a session ran under, from its opening event. */
function providerIdForSession(store: EventStore, sessionId: string): string | undefined {
  const started = store.listBySession(sessionId).find((event) => event.type === 'session.started')
    ?.payload as EventPayloads['session.started'] | undefined
  return started?.providerId
}

export function registerCredentialsIpc(
  vault: CredentialVault,
  manager: SessionManager,
  store: EventStore,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('credentials:set', (_event, providerId, key, persist) => {
    vault.set(providerId as string, key as string, persist === true)
  })
  handle('credentials:has', (_event, providerId) => vault.has(providerId as string))
  handle('credentials:clear', (_event, providerId) => {
    vault.clear(providerId as string)
  })
  // Switch an agent onto its provider's stored key — the key stays in the main
  // process; the renderer only names the session.
  handle('agent:switch-credential', (_event, sessionId) => {
    const providerId = providerIdForSession(store, sessionId as string)
    const key = providerId === undefined ? undefined : vault.get(providerId)
    return key === undefined ? undefined : manager.switchCredential(sessionId as string, key)
  })
  // Back to the default (subscription) login — no key.
  handle('agent:switch-subscription', (_event, sessionId) =>
    manager.switchCredential(sessionId as string),
  )
}

/** Encrypt credentials with the OS keychain via Electron safeStorage. */
export function safeEncryptor(): Encryptor {
  return {
    available: safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
  }
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
  createEncryptor: () => Encryptor = safeEncryptor,
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
  // Handles don't survive a restart, so a session left *running* has no live
  // agent — mark it idle so the rail shows it as done, and replying reopens it
  // via the provider's resume. A session that was already idle is left alone;
  // re-marking it every restart would pile up meaningless idle events.
  for (const sessionId of store.openSessionIds()) {
    const recentStatus = [...store.listBySession(sessionId)]
      .reverse()
      .find((event) => event.type === 'session.idle' || event.type === 'user.message')
    if (recentStatus?.type !== 'session.idle') {
      store.append('session.idle', { sessionId })
    }
  }
  registerEventIpc(store)
  registerSettingsIpc(settings)

  const broker = new PermissionBroker(makeEmitStored(store))
  const decide = broker.decide.bind(broker)

  const manager = new SessionManager(store, broadcastEvent, {
    getBudgets: () => settings.budgets(),
  })
  manager.register(createMockProvider(undefined, undefined, decide))
  manager.register(createClaudeProvider(claudeQuery, decide))
  // The deterministic, no-network agent the Playwright e2e drives.
  if (env['AGENTINATOR_MOCK_TASKS'] === '1') {
    manager.register(createE2eProvider(decide))
  }
  registerAgentIpc(manager)
  registerApprovalIpc(broker)
  registerCredentialsIpc(new CredentialVault(settings, createEncryptor()), manager, store)

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
