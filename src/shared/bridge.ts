import type { AgentType } from './agentTypes'
import type { ImageAttachment, StoredEvent } from './events'
import type { Skill } from './skills'

/** Grace window for a DENY before it reaches the agent — a mis-clicked deny
 * is the costly mistake, so it's undoable; approvals commit instantly.
 * Shared so the broker's timer and the card's countdown agree. */
export const DENY_GRACE_MS = 3000

export interface PendingApproval {
  requestId: string
  sessionId: string
  tool: string
  input: unknown
}

/** The agent a new task will run on — surfaced so the UI reflects the current
 * vendor/model instead of hardcoding one. */
export interface AgentDescriptor {
  providerId: string
  label: string
  model?: string
}

/**
 * The API the preload script exposes to the renderer as `window.agentinator`.
 * The renderer never touches Node or Electron directly — everything crosses
 * this typed bridge.
 */
export interface AgentinatorBridge {
  events: {
    count(): Promise<number>
    /** Lifetime spend across the whole log, for the status-bar readout. */
    totalCost(): Promise<number>
    /** The cumulative diff per file — newest file.diffed per path, scoped to a
     * session when given. */
    diffs(sessionId?: string): Promise<StoredEvent[]>
    list(afterSeq?: number): Promise<StoredEvent[]>
    /** Newest `limit` events oldest-first; with beforeSeq, the page before it. */
    tail(limit: number, beforeSeq?: number): Promise<StoredEvent[]>
    /** Whole-log substring search over type + payload, newest matches first. */
    search(query: string, limit: number): Promise<StoredEvent[]>
    /** Subscribe to live appends; returns an unsubscribe function. */
    onAppended(listener: (event: StoredEvent) => void): () => void
  }
  agent: {
    /** The agent a new task will run on (vendor label + optional model). */
    current(): Promise<AgentDescriptor>
    /** Launch the scripted mock session — writes real events into the log. */
    startDemo(): Promise<string>
    /** Launch a real agent on the workspace repo with a task prompt, any
     * attached images (pasted screenshots), and an optional agent-type preset
     * to run under (its instructions/model/read-only posture). */
    startTask(prompt: string, images?: ImageAttachment[], agentTypeId?: string): Promise<string>
    /** Send a follow-up message (with any attached images) into a session. */
    send(sessionId: string, text: string, images?: ImageAttachment[]): Promise<void>
    cancel(sessionId: string): Promise<void>
    /** Remove an agent from the fleet: stop it if live, then drop it from the
     * rail (records the close so a restart doesn't resurrect it). */
    dismiss(sessionId: string): Promise<void>
    /** Reconnect an agent onto its provider's stored metered API key (after a
     * plan limit), keeping its place in the fleet. */
    switchToApiKey(sessionId: string): Promise<void>
    /** Reconnect an agent back onto its subscription login. */
    switchToSubscription(sessionId: string): Promise<void>
  }
  /** Metered API keys for switching off a subscription. Write-only from the
   * renderer — keys go in and are checked, but can never be read back out. */
  credentials: {
    /** Store a key for a provider; `persist` also saves it to the OS keychain. */
    set(providerId: string, key: string, persist: boolean): Promise<void>
    /** Whether a key is available for a provider (never returns the key). */
    has(providerId: string): Promise<boolean>
    clear(providerId: string): Promise<void>
  }
  settings: {
    /** Spend ceilings per scope (session + time windows). */
    getBudgets(): Promise<import('./budget').Budgets>
    setBudget(scope: import('./budget').BudgetScope, usd: number | null): Promise<void>
    /** Whether all agents run on the metered API key (vs the subscription). */
    getApiKeyMode(): Promise<boolean>
    setApiKeyMode(on: boolean): Promise<void>
    /** The dev-server URL the preview captures, or null for the bundled sample. */
    getPreviewTarget(): Promise<string | null>
    setPreviewTarget(url: string | null): Promise<void>
    /** How long a capture waits for the page to settle after load, in ms. */
    getPreviewSettleMs(): Promise<number>
    setPreviewSettleMs(ms: number | null): Promise<void>
    /** Whether captures of this agent render its isolated worktree (its branch)
     * via a harness-run dev server, rather than the main checkout. Per-agent. */
    getWorktreePreview(sessionId: string): Promise<boolean>
    setWorktreePreview(sessionId: string, on: boolean): Promise<void>
    /** The command the harness runs to start this agent's dev server in its
     * worktree (e.g. `npm run dev`). Per-agent. */
    getPreviewServerCommand(sessionId: string): Promise<string>
    setPreviewServerCommand(sessionId: string, command: string | null): Promise<void>
  }
  /** The visual feedback loop: capture the target app and read screenshots
   * back. Bytes stay in the main process; the renderer holds only refs. */
  preview: {
    /** Capture the target app (the bundled sample when no url) for a session;
     * resolves to the artifact ref of the new screenshot. */
    capture(sessionId: string, url?: string): Promise<string>
    /** A captured screenshot's PNG as base64, or null if it's gone. */
    image(ref: string): Promise<string | null>
    /** The component workbench target pinned for one agent (app root +
     * root-relative file, an optional wrapper, and an optional props literal),
     * or null when this agent has nothing pinned. Per-session: a new agent
     * starts blank. */
    getComponent(sessionId: string): Promise<{
      root: string
      file: string
      wrapper?: string
      props?: string
    } | null>
    /** Pin a component (for this agent) to render in isolation, optionally
     * wrapped in a context provider and rendered with a props literal; a
     * null/blank file unpins it. */
    setComponent(
      sessionId: string,
      root: string,
      file: string | null,
      wrapper?: string | null,
      props?: string | null,
    ): Promise<void>
    /** Ask the agent to read the component and generate a realistic props
     * literal for it. Resolves to the props string. */
    inferProps(root: string, file: string): Promise<string>
    /** Ask the agent to generate a context wrapper for the component (mocked
     * providers), write it into the app, and resolve to the wrapper's file. */
    inferWrapper(root: string, file: string): Promise<string>
    /** Open a native folder picker for the app root; null if cancelled. */
    chooseFolder(): Promise<string | null>
    /** Open a native file picker; resolves to the path relative to `base`
     * (the app root), or null if cancelled. */
    chooseFile(base: string): Promise<string | null>
    /** Start (or reuse) the dev server for a session's worktree, resolving to
     * its URL — or null when the session isn't an isolated agent with a
     * component pinned. Rejects if the server fails to come up. */
    startWorktreeServer(sessionId: string): Promise<{ url: string } | null>
    /** Stop every running worktree dev server. */
    stopWorktreeServers(): Promise<void>
    /** How many worktree dev servers are currently running. */
    worktreeServerCount(): Promise<number>
    /** Whether the agent changed dependency manifests in its worktree, so the
     * linked node_modules (and thus the preview) may be stale. */
    worktreeDepsChanged(sessionId: string): Promise<boolean>
  }
  approvals: {
    pending(): Promise<PendingApproval[]>
    /** Schedule a decision; it reaches the agent only after the grace window. */
    resolve(requestId: string, approved: boolean): Promise<void>
    /** Abort a scheduled decision before the grace window closes. */
    undo(requestId: string): Promise<void>
  }
  /** Reusable agent presets (roles a task can launch under). */
  agentTypes: {
    /** Every saved agent type, in insertion order. */
    list(): Promise<AgentType[]>
    /** Create or update a type (upsert by id). */
    save(type: AgentType): Promise<void>
    /** Delete a type by id. */
    remove(id: string): Promise<void>
  }
  /** Reusable instruction packages attachable to agent types. */
  skills: {
    /** Every saved skill, in insertion order. */
    list(): Promise<Skill[]>
    /** Create or update a skill (upsert by id). */
    save(skill: Skill): Promise<void>
    /** Delete a skill by id. */
    remove(id: string): Promise<void>
  }
  /** The task backlog: park prompts, then dispatch them to agents on demand. */
  queue: {
    /** Park a prompt in the backlog; resolves to its task id. */
    add(prompt: string): Promise<string>
    /** Discard a queued task without running it. */
    remove(taskId: string): Promise<void>
    /** Launch a queued task as an agent; resolves to the new session id. */
    dispatch(taskId: string, prompt: string): Promise<string>
  }
  /** Multi-stage pipelines: chain agents (plan → implement → review) with each
   * stage's output handed to the next. */
  pipelines: {
    /** Launch a Plan → Implement → Review pipeline from a task prompt; resolves
     * to the new pipeline id. Stage 0 dispatches immediately. */
    create(prompt: string): Promise<string>
    /** Advance a paused pipeline past a stage boundary: launch the stage after
     * `fromSessionId` (the just-finished stage), carrying its output forward. */
    continue(pipelineId: string, fromSessionId: string): Promise<void>
    /** Re-run the paused stage (`fromSessionId`) with revision feedback — e.g.
     * reshape the plan before continuing, or request changes on a finished
     * pipeline (re-runs its final stage). */
    revise(pipelineId: string, fromSessionId: string, feedback: string): Promise<void>
    /** Sign off on a finished pipeline (the review-workbench approve). */
    approve(pipelineId: string): Promise<void>
    /** Clear a pipeline from the list (finished or abandoned); it stops
     * advancing and drops out of the UI. */
    remove(pipelineId: string): Promise<void>
  }
  /** Snapshot and rewind an isolated agent's worktree. */
  checkpoints: {
    /** Snapshot the session's worktree; resolves to the new checkpoint id, or
     * null when the session isn't isolated or the snapshot fails. */
    create(sessionId: string, label: string): Promise<string | null>
    /** Rewind the session's worktree to a checkpoint; resolves to whether it
     * succeeded. */
    restore(sessionId: string, checkpointId: string, sha: string): Promise<boolean>
  }
  /** On-demand cleanup of finished agents' git worktrees. */
  worktrees: {
    /** How many finished worktrees are still on disk, and their total size. */
    summary(): Promise<{ count: number; bytes: number }>
    /** Remove every finished worktree and its branch; resolves to how many were
     * removed and roughly the bytes freed. */
    cleanup(): Promise<{ count: number; bytes: number }>
  }
}
