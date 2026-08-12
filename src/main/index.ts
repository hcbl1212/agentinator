import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'

import type { BudgetScope } from '../shared/budget'
import type { EventPayloads, ImageAttachment, StoredEvent } from '../shared/events'
import { PermissionBroker } from './approvals'
import type { EmitStored } from './approvals'
import { FileArtifactStore } from './artifacts'
import type { ArtifactStore } from './artifacts'
import { ComponentWorkbench } from './componentWorkbench'
import { makePropInferrer, makeWrapperInferrer } from './componentInference'
import { CredentialVault } from './credentials'
import type { Encryptor } from './credentials'
import { EventStore } from './eventStore'
import { DevServers, linkNodeModules, spawnDevServer } from './devServers'
import type { GitRunner } from './git'
import { runGit, runGitSync } from './git'
import { worktreeDepsChanged } from './workspaceDiff'
import { dirSizeBytes, WorktreeJanitor } from './worktreeGc'
import { NodeWorktrees } from './worktrees'
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

export function registerWorktreeIpc(
  janitor: WorktreeJanitor,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('worktrees:summary', () => janitor.summary())
  handle('worktrees:cleanup', () => janitor.cleanup())
}

export function registerWorktreeServerIpc(
  start: (sessionId: string) => Promise<{ url: string } | null>,
  stopAll: () => void,
  count: () => number,
  depsChanged: (sessionId: string) => Promise<boolean>,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('preview:start-worktree-server', (_event, sessionId) => start(sessionId as string))
  handle('preview:stop-worktree-servers', () => {
    stopAll()
  })
  handle('preview:worktree-server-count', () => count())
  handle('preview:worktree-deps-changed', (_event, sessionId) => depsChanged(sessionId as string))
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
  handle('settings:get-preview-settle-ms', () => settings.previewSettleMs())
  handle('settings:set-preview-settle-ms', (_event, ms) => {
    settings.setPreviewSettleMs(ms as number | null)
  })
  handle('settings:get-worktree-preview', () => settings.worktreePreview())
  handle('settings:set-worktree-preview', (_event, on) => {
    settings.setWorktreePreview(on === true)
  })
  handle('settings:get-preview-server-command', () => settings.previewServerCommand())
  handle('settings:set-preview-server-command', (_event, command) => {
    settings.setPreviewServerCommand(command as string | null)
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
  inferProps: (root: string, file: string) => Promise<string>,
  inferWrapperSource: (root: string, file: string) => Promise<string>,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('preview:capture', (_event, sessionId, url) =>
    preview.capture(sessionId as string, url as string | undefined),
  )
  handle('preview:image', (_event, ref) => preview.image(ref as string))
  handle('preview:get-component', () => settings.component() ?? null)
  handle('preview:set-component', (_event, root, file, wrapper, props) => {
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
      props as string | null | undefined,
    )
  })
  // Ask the agent to read the component and generate realistic props for it.
  handle('preview:infer-props', (_event, root, file) => inferProps(root as string, file as string))
  // Ask the agent to generate a context wrapper, write it, and return its name.
  handle('preview:infer-wrapper', async (_event, root, file) => {
    const source = await inferWrapperSource(root as string, file as string)
    return workbench.writeWrapper(root as string, source)
  })
}

/** The subset of Electron's dialog.showOpenDialog the pickers use — injected so
 * the handlers are testable without a real dialog. */
export type OpenDialog = (options: {
  properties: Array<'openDirectory' | 'openFile'>
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}) => Promise<{ canceled: boolean; filePaths: string[] }>

export function registerDialogIpc(
  showOpenDialog: OpenDialog,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  // Pick the app root (an absolute folder path).
  handle('dialog:choose-folder', async () => {
    const result = await showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  // Pick a component/wrapper file and return it relative to `base` (the app root)
  // so it maps to a dev-server URL path.
  handle('dialog:choose-file', async (_event, base) => {
    const from = base as string
    const result = await showOpenDialog({
      properties: ['openFile'],
      defaultPath: from,
      filters: [{ name: 'Components', extensions: ['tsx', 'jsx', 'ts', 'js'] }],
    })
    return result.canceled || result.filePaths.length === 0
      ? null
      : relative(from, result.filePaths[0])
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

/** The session-manager event sink: broadcast to the renderer, and stop a
 * session's worktree dev server when it ends (dismissed / completed / failed)
 * so preview servers don't outlive the agents that own them. */
export function reapWorktreeServer(
  devServers: DevServers,
  broadcast = broadcastEvent,
): (event: StoredEvent) => void {
  return (event) => {
    broadcast(event)
    if (event.type === 'session.ended') {
      devServers.stop((event.payload as { sessionId: string }).sessionId)
    }
  }
}

/**
 * Resolve the worktree dev-server preview for a session: null unless worktree
 * preview is on, a component is pinned, and the session is an isolated agent.
 * Then start (or reuse) a dev server in the worktree's server dir and return
 * its URL plus where the component entry should be written.
 */
export async function resolveWorktreePreview(
  sessionId: string,
  store: EventStore,
  settings: SettingsStore,
  devServers: DevServers,
): Promise<{ url: string; root: string; file: string; wrapper?: string; props?: string } | null> {
  if (!settings.worktreePreview()) {
    return null
  }
  const component = settings.component()
  if (component === undefined) {
    return null
  }
  const started = store.listBySession(sessionId).find((event) => event.type === 'session.started')
    ?.payload as EventPayloads['session.started'] | undefined
  const worktree = started?.worktree
  if (worktree === undefined) {
    return null
  }
  // The component root sits under the repo (e.g. <repo>/frontend); the same
  // subdir inside the worktree is where the isolated dev server runs.
  const serverCwd = join(worktree.path, relative(worktree.repoRoot, component.root))
  const url = await devServers.ensure(
    sessionId,
    serverCwd,
    component.root,
    settings.previewServerCommand(),
  )
  return {
    url,
    root: serverCwd,
    file: component.file,
    wrapper: component.wrapper,
    props: component.props,
  }
}

/** Whether the agent changed dependency manifests in a session's worktree (so
 * the linked node_modules is stale). False when the session isn't isolated. */
export async function resolveWorktreeDepsChanged(
  sessionId: string,
  store: EventStore,
  git: GitRunner,
): Promise<boolean> {
  const started = store.listBySession(sessionId).find((event) => event.type === 'session.started')
    ?.payload as EventPayloads['session.started'] | undefined
  const worktree = started?.worktree
  return worktree === undefined ? false : worktreeDepsChanged(worktree.path, git)
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
  // One dev server per agent worktree, so an isolated agent's component edits
  // can be previewed on its own branch. node_modules is gitignored (absent in a
  // fresh worktree), so link the main checkout's before starting.
  const devServers = new DevServers({ spawn: spawnDevServer, linkModules: linkNodeModules })
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
      settleMs: settings.previewSettleMs.bind(settings),
      worktreePreview: (sessionId) =>
        resolveWorktreePreview(sessionId, store, settings, devServers),
    },
  )

  const vault = new CredentialVault(settings, createEncryptor())
  const worktrees = new NodeWorktrees(join(userData, 'worktrees'), runGitSync)
  const manager = new SessionManager(store, reapWorktreeServer(devServers), {
    getBudgets: () => settings.budgets(),
    // Fresh/reopened sessions run on the API key only when the global toggle is
    // on and a key is stored for the provider — otherwise the plan.
    resolveApiKey: (providerId) => (settings.apiKeyMode() ? vault.get(providerId) : undefined),
    // Each real agent gets its own git worktree under userData, so concurrent
    // agents can't corrupt each other's working tree.
    worktrees,
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
  registerWorktreeIpc(
    new WorktreeJanitor({
      endedWorktrees: () => store.endedWorktrees(),
      exists: existsSync,
      sizeOf: dirSizeBytes,
      worktrees,
    }),
  )
  registerWorktreeServerIpc(
    (sessionId) => resolveWorktreePreview(sessionId, store, settings, devServers),
    () => devServers.stopAll(),
    () => devServers.count(),
    (sessionId) => resolveWorktreeDepsChanged(sessionId, store, runGit),
  )
  registerApprovalIpc(broker)
  registerCredentialsIpc(vault, manager, store)
  registerPreviewIpc(
    preview,
    settings,
    workbench,
    makePropInferrer(claudeQuery),
    makeWrapperInferrer(claudeQuery),
  )
  registerDialogIpc(dialog.showOpenDialog.bind(dialog))

  createWindow()
  if (replayPath !== undefined) {
    void replay(replayPath, store, broadcastEvent)
  }
  // Quit on last window close on every platform, including macOS. The harness
  // has no background work yet, so a closed window leaving the process (and
  // `npm run dev`) alive is a trap. Revisit as a tray/dock mode once agents
  // run in the main process and must outlive the window.
  electronApp.on('window-all-closed', () => {
    devServers.stopAll()
    electronApp.quit()
  })

  return store
}
