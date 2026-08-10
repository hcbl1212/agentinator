import { join } from 'node:path'

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'

import type { BudgetScope } from '../shared/budget'
import type { EventPayloads, ImageAttachment, StoredEvent } from '../shared/events'
import { PermissionBroker } from './approvals'
import type { EmitStored } from './approvals'
import { FileArtifactStore } from './artifacts'
import type { ArtifactStore } from './artifacts'
import { ComponentWorkbench } from './componentWorkbench'
import { CredentialVault } from './credentials'
import type { Encryptor } from './credentials'
import { EventStore } from './eventStore'
import { runGit } from './git'
import { PreviewController } from './preview'
import { ElectronPreviewBrowser } from './previewBrowser'
import type { PreviewBrowser } from './previewBrowser'
import { SettingsStore } from './settingsStore'
import { createClaudeProvider } from './providers/claude'
import type { ClaudeQuery, SdkCreateServer, SdkTool } from './providers/claude'
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
  handle('settings:get-api-key-mode', () => settings.apiKeyMode())
  handle('settings:set-api-key-mode', (_event, on) => {
    settings.setApiKeyMode(on === true)
  })
  handle('settings:get-preview-target', () => settings.previewTarget() ?? null)
  handle('settings:set-preview-target', (_event, url) => {
    settings.setPreviewTarget(url as string | null)
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

export function registerPreviewIpc(
  preview: PreviewController,
  settings: SettingsStore,
  workbench: ComponentWorkbench,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('preview:capture', (_event, sessionId, url) =>
    preview.capture(sessionId as string, url as string | undefined),
  )
  handle('preview:image', (_event, ref) => preview.image(ref as string))
  handle('preview:get-component', () => settings.component() ?? null)
  handle('preview:set-component', (_event, root, file, wrapper) => {
    const trimmed = typeof file === 'string' ? file.trim() : ''
    // Clearing the pin removes the entry we wrote into the app root.
    if (trimmed === '') {
      const current = settings.component()
      if (current !== undefined) {
        workbench.clear(current.root)
      }
    }
    settings.setComponent(
      root as string,
      file as string | null,
      wrapper as string | null | undefined,
    )
  })
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
  createPreviewBrowser: () => PreviewBrowser = () => new ElectronPreviewBrowser(),
  createArtifacts: (dir: string) => ArtifactStore = (dir) => new FileArtifactStore(dir),
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

  // The visual-feedback loop: capture the target app into the artifact store
  // (kept off the event log) and preview it. The sample app ships alongside the
  // bundled main (out/main → ../../examples), resolved the same way in dev and
  // inside the packaged asar — getAppPath is unreliable when launched as
  // `electron out/main/entry.js`. A real workspace dev-server URL becomes the
  // target later.
  const sampleTarget = join(import.meta.dirname, '../../examples/sample-web/index.html')
  const workbench = new ComponentWorkbench()
  const preview = new PreviewController(
    createPreviewBrowser(),
    createArtifacts(join(userData, 'screenshots')),
    makeEmitStored(store),
    // A pinned component wins; else the configured dev-server URL; else sample.
    {
      previewTarget: settings.previewTarget.bind(settings),
      component: settings.component.bind(settings),
      workbench,
      sample: sampleTarget,
    },
  )

  const vault = new CredentialVault(settings, createEncryptor())
  const manager = new SessionManager(store, broadcastEvent, {
    getBudgets: () => settings.budgets(),
    // Fresh/reopened sessions run on the API key only when the global toggle is
    // on and a key is stored for the provider — otherwise the plan.
    resolveApiKey: (providerId) => (settings.apiKeyMode() ? vault.get(providerId) : undefined),
  })
  manager.register(createMockProvider(undefined, undefined, decide))
  // Hand Claude the app-capture tool so the agent can see what it builds.
  manager.register(
    createClaudeProvider(
      claudeQuery,
      decide,
      {
        capture: preview.captureImage.bind(preview),
        // Narrowed to the adapter's own SDK-free types (like `query` above), so
        // the provider never depends on the SDK's exact generics.
        tool: tool as unknown as SdkTool,
        createSdkMcpServer: createSdkMcpServer as unknown as SdkCreateServer,
      },
      runGit,
    ),
  )
  // The deterministic, no-network agent the Playwright e2e drives.
  if (env['AGENTINATOR_MOCK_TASKS'] === '1') {
    manager.register(createE2eProvider(decide))
  }

  registerAgentIpc(manager)
  registerApprovalIpc(broker)
  registerCredentialsIpc(vault, manager, store)
  registerPreviewIpc(preview, settings, workbench)

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
