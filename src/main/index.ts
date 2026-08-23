import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron'

import type { AgentType } from '../shared/agentTypes'
import type { BudgetScope } from '../shared/budget'
import type { Skill } from '../shared/skills'
import { createEntityId } from '../shared/events'
import type { EventPayloads, ImageAttachment, StoredEvent } from '../shared/events'
import { PermissionBroker } from './approvals'
import type { EmitStored } from './approvals'
import { FileArtifactStore } from './artifacts'
import type { ArtifactStore } from './artifacts'
import { ComponentWorkbench } from './componentWorkbench'
import { makePropInferrer, makeWrapperInferrer } from './componentInference'
import { CredentialVault } from './credentials'
import type { Encryptor } from './credentials'
import { AttentionTracker } from './attention'
import type { AttentionNotifier } from './attention'
import { EventStore } from './eventStore'
import { DevServers, linkNodeModules, spawnDevServer } from './devServers'
import type { GitRunner } from './git'
import { runGit, runGitSync } from './git'
import { worktreeDepsChanged } from './workspaceDiff'
import { dirSizeBytes, WorktreeJanitor } from './worktreeGc'
import { NodeCheckpoints } from './checkpoints'
import type { Checkpoints } from './checkpoints'
import { NodeWorktrees } from './worktrees'
import type { WorktreeInfo } from './worktrees'
import { defaultPipelineStages, PipelineOrchestrator } from './pipelines'
import { decomposePlanWith, scriptedDecomposer } from './planDecomposer'
import type { PlanDecomposer } from './planDecomposer'
import { PlanOrchestrator } from './plans'
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

/** Snapshot/rewind an isolated agent's worktree — the checkpoint lifecycle,
 * recorded in the log so the renderer lists checkpoints and survives a restart.
 * The create/restore closures (built in bootstrap) do the git + emit. */
export function registerCheckpointIpc(
  create: (sessionId: string, label: string) => string | null,
  restore: (sessionId: string, checkpointId: string, sha: string) => boolean,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('checkpoints:create', (_event, sessionId, label) =>
    create(sessionId as string, label as string),
  )
  handle('checkpoints:restore', (_event, sessionId, checkpointId, sha) =>
    restore(sessionId as string, checkpointId as string, sha as string),
  )
}

export function registerAgentIpc(
  manager: SessionManager,
  agentTypes: () => AgentType[],
  skills: () => Skill[],
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  const taskProvider = taskProviderId()
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
  handle('agent:start-task', (_event, prompt, images, agentTypeId) =>
    startAgentTask(manager, prompt as string, {
      images: images as ImageAttachment[] | undefined,
      ...agentTaskOptions(agentTypeId, agentTypes, skills),
    }),
  )
  handle('agent:send', (_event, sessionId, text, images) =>
    manager.send(sessionId as string, text as string, images as ImageAttachment[] | undefined),
  )
  handle('agent:cancel', (_event, sessionId) => manager.cancel(sessionId as string))
  handle('agent:dismiss', (_event, sessionId) => manager.dismiss(sessionId as string))
}

/** Agent-type presets (reusable roles a task can launch under). Stored in the
 * settings store; the renderer manages them and the composer picks one. */
export function registerAgentTypeIpc(
  settings: SettingsStore,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('agent-types:list', () => settings.agentTypes())
  handle('agent-types:save', (_event, type) => {
    settings.saveAgentType(type as AgentType)
  })
  handle('agent-types:remove', (_event, id) => {
    settings.removeAgentType(id as string)
  })
}

/** Skills (reusable instruction packages attachable to agent types). Stored in
 * the settings store; the renderer manages them. */
export function registerSkillIpc(
  settings: SettingsStore,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('skills:list', () => settings.skills())
  handle('skills:save', (_event, skill) => {
    settings.saveSkill(skill as Skill)
  })
  handle('skills:remove', (_event, id) => {
    settings.removeSkill(id as string)
  })
}

/** The task backlog: park prompts, then dispatch them to agents on demand.
 * Queue state lives in the event log (task.queued/dispatched/removed) so the
 * renderer reduces it live and it survives restarts. */
export function registerQueueIpc(
  manager: SessionManager,
  emit: EmitStored,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('queue:add', (_event, prompt) => {
    const taskId = createEntityId('task')
    emit('task.queued', { taskId, prompt: prompt as string })
    return taskId
  })
  handle('queue:remove', (_event, taskId) => {
    emit('task.removed', { taskId: taskId as string })
  })
  handle('queue:dispatch', (_event, taskId, prompt) => {
    const sessionId = startAgentTask(manager, prompt as string)
    emit('task.dispatched', { taskId: taskId as string, sessionId })
    return sessionId
  })
}

/** Launch multi-stage pipelines. A pipeline is created from a task prompt using
 * the built-in Plan → Implement → Review template; the orchestrator dispatches
 * stage 0 and advances the rest as each stage's agent finishes. */
export function registerPipelineIpc(
  pipelines: PipelineOrchestrator,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('pipelines:create', (_event, prompt) => {
    const task = prompt as string
    return pipelines.create(taskTitle(task), defaultPipelineStages(task))
  })
  handle('pipelines:continue', (_event, pipelineId, fromSessionId) => {
    pipelines.continueStage(pipelineId as string, fromSessionId as string)
  })
  handle('pipelines:revise', (_event, pipelineId, fromSessionId, feedback) => {
    pipelines.reviseStage(pipelineId as string, fromSessionId as string, feedback as string)
  })
  handle('pipelines:approve', (_event, pipelineId) => {
    pipelines.approve(pipelineId as string)
  })
  handle('pipelines:remove', (_event, pipelineId) => {
    pipelines.remove(pipelineId as string)
  })
}

/** The planner: decompose a requirement into a task DAG (the AI call happens
 * here, before the plan exists), then dispatch ready tasks and clear plans. */
export function registerPlannerIpc(
  plans: PlanOrchestrator,
  decompose: PlanDecomposer,
  handle: (channel: string, listener: IpcHandler) => void = (channel, listener) => {
    ipcMain.handle(channel, listener)
  },
): void {
  handle('planner:create', async (_event, requirement) => {
    const tasks = await decompose(requirement as string)
    return plans.create(taskTitle(requirement as string), requirement as string, tasks)
  })
  handle('planner:dispatch', (_event, planId, taskId) =>
    plans.dispatch(planId as string, taskId as string),
  )
  handle('planner:remove', (_event, planId) => {
    plans.remove(planId as string)
  })
  handle('planner:add-edge', (_event, planId, taskId, dependsOnTaskId) =>
    plans.addEdge(planId as string, taskId as string, dependsOnTaskId as string),
  )
  handle('planner:remove-edge', (_event, planId, taskId, dependsOnTaskId) =>
    plans.removeEdge(planId as string, taskId as string, dependsOnTaskId as string),
  )
}

/** The provider a "Run task" (and a dispatched queue item) uses. Swapping this
 * is all it takes to point the UI at another vendor. The e2e sets
 * AGENTINATOR_MOCK_TASKS to drive the deterministic mock with no network. */
export function taskProviderId(): string {
  return process.env['AGENTINATOR_MOCK_TASKS'] === '1' ? 'e2e' : 'claude'
}

/** Per-launch overrides for {@link startAgentTask}: attached images, a worktree
 * to reuse (a pipeline stage), and an agent type's posture (read-only,
 * instructions, model). */
export interface AgentTaskOptions {
  images?: ImageAttachment[]
  worktree?: WorktreeInfo
  readOnly?: boolean
  instructions?: string
  model?: string
}

/** Start an agent from a task prompt (a fresh launch, a dispatched queue item,
 * or a pipeline stage), returning the new session id. */
export function startAgentTask(
  manager: SessionManager,
  prompt: string,
  options: AgentTaskOptions = {},
): string {
  return manager.start({
    providerId: taskProviderId(),
    title: taskTitle(prompt),
    prompt,
    ...options,
    // The workspace repo — for now the process cwd (the repo when run via
    // `npm run dev`); explicit workspace/dir selection arrives in Phase 5.
    cwd: process.cwd(),
  })
}

/** An agent type's launch posture (its instructions plus every attached skill's
 * body), or empty when none/unknown is chosen. */
export function agentTaskOptions(
  agentTypeId: unknown,
  types: () => AgentType[],
  skills: () => Skill[],
): Pick<AgentTaskOptions, 'instructions' | 'model' | 'readOnly'> {
  if (typeof agentTypeId !== 'string') {
    return {}
  }
  const type = types().find((candidate) => candidate.id === agentTypeId)
  if (type === undefined) {
    return {}
  }
  const all = skills()
  const bodies = (type.skillIds ?? [])
    .map((id) => all.find((skill) => skill.id === id))
    .filter((skill): skill is Skill => skill !== undefined)
    .map((skill) => `# ${skill.name}\n${skill.body}`)
  const instructions = [type.instructions, ...bodies].filter((part) => part.length > 0).join('\n\n')
  return {
    instructions: instructions === '' ? undefined : instructions,
    model: type.model,
    readOnly: type.readOnly,
  }
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
  handle('settings:get-worktree-preview', (_event, sessionId) =>
    settings.worktreePreview(sessionId as string),
  )
  handle('settings:set-worktree-preview', (_event, sessionId, on) => {
    settings.setWorktreePreview(sessionId as string, on === true)
  })
  handle('settings:get-preview-server-command', (_event, sessionId) =>
    settings.previewServerCommand(sessionId as string),
  )
  handle('settings:set-preview-server-command', (_event, sessionId, command) => {
    settings.setPreviewServerCommand(sessionId as string, command as string | null)
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
  handle(
    'preview:get-component',
    (_event, sessionId) => settings.component(sessionId as string) ?? null,
  )
  handle('preview:set-component', (_event, sessionId, root, file, wrapper, props) => {
    const trimmed = typeof file === 'string' ? file.trim() : ''
    // Clearing the pin removes the entry we wrote into the app root.
    if (trimmed === '') {
      const current = settings.component(sessionId as string)
      if (current !== undefined) {
        workbench.clear(current.root)
      }
    }
    settings.setComponent(
      sessionId as string,
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

/** The one place every emitted event flows through: broadcast it to the
 * renderer, stop a session's worktree dev server when it ends (so preview
 * servers don't outlive their agents), and feed the attention tracker (native
 * notifications + dock badge). */
export function mainEventSink(
  devServers: DevServers,
  attention: AttentionTracker,
  observePipeline: (event: StoredEvent) => void,
  broadcast = broadcastEvent,
): (event: StoredEvent) => void {
  return (event) => {
    broadcast(event)
    if (event.type === 'session.ended') {
      devServers.stop((event.payload as { sessionId: string }).sessionId)
    }
    attention.observe(event)
    // Advance any pipeline this event belongs to (a stage's agent ending).
    observePipeline(event)
  }
}

/** The native side of the attention inbox: a system notification and the dock
 * badge (macOS only — app.dock is undefined elsewhere). */
export function nativeAttentionNotifier(): AttentionNotifier {
  return {
    notify: (title, body) => {
      new Notification({ title, body }).show()
    },
    setBadge: (count) => {
      app.dock?.setBadge(count > 0 ? String(count) : '')
    },
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
  if (!settings.worktreePreview(sessionId)) {
    return null
  }
  const component = settings.component(sessionId)
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
    settings.previewServerCommand(sessionId),
  )
  return {
    url,
    root: serverCwd,
    file: component.file,
    wrapper: component.wrapper,
    props: component.props,
  }
}

/** Snapshot a session's worktree and log it; returns the new checkpoint id, or
 * null when the session isn't isolated or the snapshot fails. */
export function createCheckpoint(
  sessionId: string,
  label: string,
  store: EventStore,
  checkpoints: Checkpoints,
  emit: EmitStored,
): string | null {
  const path = resolveWorktreePath(sessionId, store)
  const sha = path === null ? null : checkpoints.create(path, label)
  if (sha === null) {
    return null
  }
  const checkpointId = createEntityId('checkpoint')
  emit('checkpoint.created', { sessionId, checkpointId, label, sha })
  return checkpointId
}

/** Rewind a session's worktree to a checkpoint and log it; returns success. */
export function restoreCheckpoint(
  sessionId: string,
  checkpointId: string,
  sha: string,
  store: EventStore,
  checkpoints: Checkpoints,
  emit: EmitStored,
): boolean {
  const path = resolveWorktreePath(sessionId, store)
  const restored = path !== null && checkpoints.restore(path, sha)
  if (restored) {
    emit('checkpoint.restored', { sessionId, checkpointId })
  }
  return restored
}

/** A session's isolated worktree path (from its session.started event), or null
 * when the session isn't isolated. */
export function resolveWorktreePath(sessionId: string, store: EventStore): string | null {
  const started = store.listBySession(sessionId).find((event) => event.type === 'session.started')
    ?.payload as EventPayloads['session.started'] | undefined
  return started?.worktree?.path ?? null
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

  // One dev server per agent worktree, so an isolated agent's component edits
  // can be previewed on its own branch. node_modules is gitignored (absent in a
  // fresh worktree), so link the main checkout's before starting.
  const devServers = new DevServers({ spawn: spawnDevServer, linkModules: linkNodeModules })
  const attention = new AttentionTracker(nativeAttentionNotifier())
  // Seed the dock badge from the log's still-open questions so it's accurate at
  // launch (not stuck at zero until the next live event).
  attention.reconcile(store.list())
  // The pipeline orchestrator is built before the sink so the sink can hand it
  // every event (to advance a stage when its agent ends). It dispatches stages
  // through the manager, which is assigned just below and captured by closure —
  // a stage only ever starts at runtime, long after wiring. The orchestrator is
  // built after the manager it dispatches through, so the sink reaches it via
  // this observer list (empty until the orchestrator registers below). Its own
  // pipeline.* events only need the renderer, so they broadcast directly rather
  // than looping back through the sink.
  const pipelineObservers: Array<(event: StoredEvent) => void> = []
  // Every emitted event flows through this: broadcast, reap dev servers on end,
  // drive the attention inbox's notifications + dock badge, and advance pipelines.
  const sink = mainEventSink(devServers, attention, (event) => {
    pipelineObservers.forEach((observe) => observe(event))
  })

  const broker = new PermissionBroker(makeEmitStored(store, sink))
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
    makeEmitStored(store, sink),
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
  const manager = new SessionManager(store, sink, {
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

  // The orchestrator dispatches stages through the manager (now built) and
  // advances on each stage's session.ended, which reaches it via the sink's
  // observer list. Rebuild any in-flight pipeline from the log so it keeps
  // advancing across a restart.
  const pipelines = new PipelineOrchestrator({
    emit: makeEmitStored(store),
    store,
    startStage: (prompt, worktree, readOnly, model) =>
      startAgentTask(manager, prompt, { worktree, readOnly, model }),
    retireStage: (sessionId) => void manager.retire(sessionId),
  })
  pipelineObservers.push(pipelines.observe.bind(pipelines))
  pipelines.reconcile(store.list())

  // The planner shares the pipelines' shape: dispatch through the manager,
  // observe session lifecycle via the sink's observer list, rebuild from the
  // log at boot. Mock-tasks mode swaps in the scripted decomposer so the e2e
  // plans deterministically with no network.
  const plans = new PlanOrchestrator({
    emit: makeEmitStored(store),
    store,
    startTask: (prompt) => startAgentTask(manager, prompt),
  })
  pipelineObservers.push(plans.observe.bind(plans))
  plans.reconcile(store.list())

  registerAgentIpc(manager, settings.agentTypes.bind(settings), settings.skills.bind(settings))
  registerAgentTypeIpc(settings)
  registerSkillIpc(settings)
  registerQueueIpc(manager, makeEmitStored(store, sink))
  registerPipelineIpc(pipelines)
  registerPlannerIpc(
    plans,
    env['AGENTINATOR_MOCK_TASKS'] === '1' ? scriptedDecomposer : decomposePlanWith(claudeQuery),
  )
  const checkpoints = new NodeCheckpoints(runGitSync)
  const emitCheckpoint = makeEmitStored(store, sink)
  registerCheckpointIpc(
    (sessionId, label) => createCheckpoint(sessionId, label, store, checkpoints, emitCheckpoint),
    (sessionId, checkpointId, sha) =>
      restoreCheckpoint(sessionId, checkpointId, sha, store, checkpoints, emitCheckpoint),
  )
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
