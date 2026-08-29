/**
 * The normalized event schema — the one language every part of Agentinator
 * speaks. Vendor adapters map their payloads INTO these types; the UI renders
 * FROM them. Schema evolution is append-only: add new event types, never
 * mutate or repurpose existing ones (old logs must replay forever).
 */

import type { AccountLimit, AccountUsage } from './usage'

export const ENTITY_KINDS = [
  'workspace',
  'repo',
  'session',
  'agent',
  'task',
  'approval',
  'checkpoint',
  'pipeline',
  'plan',
] as const

/** One stage of a pipeline: a human label and the prompt its agent runs with.
 * The whole ordered list is recorded on `pipeline.created`, so the chain (and
 * each stage's intent) replays from the log alone. */
export interface PipelineStageSpec {
  name: string
  prompt: string
  /** Run this stage read-only — the agent may read/search but cannot edit files
   * or run commands (a planning stage). The provider enforces it. */
  readOnly?: boolean
  /** The model this stage runs on (stage-aware routing) — a cheaper/faster model
   * for lighter stages. Undefined uses the provider default. */
  model?: string
}

/** One task of a plan: what to do and which sibling tasks must finish first.
 * The whole list is recorded on `plan.created` (like a pipeline's stages), so
 * the dependency graph replays from the log alone. */
export interface PlanTaskSpec {
  taskId: string
  /** A short human label for the tree. */
  title: string
  /** The prompt the dispatched agent runs with. */
  prompt: string
  /** taskIds (within the same plan) this task waits on — its "blocked by". */
  dependsOn: string[]
  /** The agent-type preset this task dispatches under (its role: instructions,
   * model, read-only posture, skills) — suggested by the decomposer, editable
   * until dispatch. Undefined runs the default agent. */
  agentTypeId?: string
}

export type EntityKind = (typeof ENTITY_KINDS)[number]

export function createEntityId(kind: EntityKind): string {
  return `${kind}_${crypto.randomUUID()}`
}

/** A base64 image attached to a message (e.g. a pasted screenshot), carried to
 * vision-capable providers. `data` is base64 with no data-URL prefix. */
export interface ImageAttachment {
  mediaType: string
  data: string
}

/** One console line captured from the previewed app — surfaced to the human and
 * fed to the agent so runtime errors are visible, not just the pixels. A failed
 * page load is recorded here as an `error` entry too. */
export interface ConsoleEntry {
  level: 'info' | 'warning' | 'error' | 'debug'
  text: string
}

/** One network request the previewed app made during a capture — so a failing
 * API call is visible alongside the pixels. `status` is 0 when the request
 * errored before a response. */
export interface NetworkEntry {
  method: string
  url: string
  status: number
  ok: boolean
}

/** One turn of a prior conversation, reconstructed from the log — the
 * vendor-agnostic material any provider can replay to resume a session. */
export interface ResumeTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface EventPayloads {
  /** Emitted once per app launch — proves the fabric end-to-end. */
  'app.started': { version: string }
  'session.started': {
    sessionId: string
    agentId: string
    workspaceId: string
    title: string
    /** The provider running the session (e.g. "claude") — shown per agent. */
    providerId?: string
    /** The isolated git worktree this session runs in — its own branch off the
     * repo so concurrent agents never share a working tree. Present only when
     * the provider isolates and the cwd is a git repo; absent otherwise (the
     * session then runs directly in the repo). Persisted so resume can reuse it
     * and dismiss can tear it down. */
    worktree?: { repoRoot: string; path: string; branch: string }
  }
  'session.ended': { sessionId: string; outcome: 'completed' | 'cancelled' | 'failed' }
  'agent.text': { sessionId: string; text: string }
  'agent.thinking': { sessionId: string; summary: string }
  /** A turn finished; the session is alive and awaiting a follow-up message. */
  'session.idle': { sessionId: string }
  /** The model the session is actually running, captured from the provider's
   * stream (the SDK reports it) — shown per agent in the rail. */
  'session.model': { sessionId: string; model: string }
  /** Which credential the provider authenticated with — surfaced so switching
   * an agent onto a metered API key is visible. */
  'session.auth': { sessionId: string; source: string }
  /** The credential the manager handed the session — emitted immediately on
   * start/resume/switch so the rail toggle reflects the choice at once, before
   * the provider confirms it via session.auth. */
  'session.credential': { sessionId: string; metered: boolean }
  /** A vendor-native token that can reopen this conversation after a restart
   * (e.g. the Claude SDK session id). Persisted so resume survives the app. */
  'session.resumable': { sessionId: string; resumeToken: string }
  /** A dead session was reopened and is live again. */
  'session.resumed': { sessionId: string }
  /** A task parked in the backlog, awaiting dispatch to an agent. */
  'task.queued': { taskId: string; prompt: string }
  /** A queued task was launched as an agent — links the task to its session. */
  'task.dispatched': { taskId: string; sessionId: string }
  /** A queued task was discarded without ever running. */
  'task.removed': { taskId: string }
  /** A multi-stage pipeline was launched: its ordered stages are recorded here
   * so the whole chain replays from the log. Stage 0 dispatches immediately. */
  'pipeline.created': { pipelineId: string; title: string; stages: PipelineStageSpec[] }
  /** A pipeline stage was dispatched as an agent — links the stage to its
   * session so the UI and the orchestrator can follow it. */
  'pipeline.stage.started': { pipelineId: string; stageIndex: number; sessionId: string }
  /** A stage's agent finished successfully; the next stage (if any) advances. */
  'pipeline.stage.completed': { pipelineId: string; stageIndex: number; sessionId: string }
  /** Every stage completed — the pipeline is done. */
  'pipeline.completed': { pipelineId: string }
  /** The user reviewed a finished pipeline and approved it (the review-workbench
   * sign-off). Requesting changes instead re-runs the final stage (revise). */
  'pipeline.approved': { pipelineId: string }
  /** The user cleared a pipeline from the list (finished or abandoned); it stops
   * advancing and drops out of the UI. */
  'pipeline.removed': { pipelineId: string }
  /** A stage's agent failed or was cancelled; the pipeline halts at that stage. */
  'pipeline.failed': { pipelineId: string; stageIndex: number; sessionId: string }
  /** A requirement was decomposed into a dependency-aware task list (the
   * planner). The full graph is recorded here so it replays from one event;
   * tasks with no unmet dependencies form the "ready to start" frontier. */
  'plan.created': { planId: string; title: string; requirement: string; tasks: PlanTaskSpec[] }
  /** A ready plan task was launched as an agent — links the task to its
   * session so live plan status can follow it. */
  'plan.task.dispatched': { planId: string; taskId: string; sessionId: string }
  /** A ready plan task was launched as a full Plan→Implement→Review pipeline
   * instead of a single agent — links the task to its pipeline. The plan
   * decides WHEN work is ready; the pipeline decides HOW carefully it runs. */
  'plan.task.pipelined': { planId: string; taskId: string; pipelineId: string }
  /** A dispatched task finished cleanly — tasks depending on it may now join
   * the ready frontier. sessionId is absent when a pipeline (not a single
   * agent) completed it — an added-optional keeps old logs replaying. */
  'plan.task.completed': { planId: string; taskId: string; sessionId?: string }
  /** A dispatched task was cancelled or failed; the task may be dispatched
   * again (a retry). sessionId is absent when a pipeline failed it. */
  'plan.task.failed': { planId: string; taskId: string; sessionId?: string }
  /** The user cleared a plan; it stops tracking and drops out of the UI. */
  'plan.removed': { planId: string }
  /** The user drew a dependency edge on the plan canvas: `taskId` now also
   * waits on `dependsOnTaskId`. Guarded upstream (no cycles, no self, no
   * editing an already-dispatched task), so a logged edge is always valid. */
  'plan.edge.added': { planId: string; taskId: string; dependsOnTaskId: string }
  /** The user removed a dependency edge — `taskId` no longer waits on
   * `dependsOnTaskId`, which may put it on the ready frontier. */
  'plan.edge.removed': { planId: string; taskId: string; dependsOnTaskId: string }
  /** The user reassigned which agent-type preset a task will dispatch under
   * (null returns it to the default agent). Guarded upstream: only tasks that
   * haven't dispatched yet can be retyped. */
  'plan.task.retyped': { planId: string; taskId: string; agentTypeId: string | null }
  /** RETIRED (never repurpose): superseded by plan.task.reprompted — the user
   * now edits the brief itself rather than layering notes. Kept so logs that
   * recorded notes still replay. */
  'plan.task.noted': { planId: string; taskId: string; note: string }
  /** The user rewrote a task's brief (the prompt its agent will run with).
   * Guarded upstream: only tasks that haven't dispatched can be reprompted —
   * a launched agent's brief is history. */
  'plan.task.reprompted': { planId: string; taskId: string; prompt: string }
  /** A task was expanded into a sub-plan IN PLACE: the recorded tasks replace
   * it at its position in the graph. Their roots already carry the parent's
   * dependencies; tasks that waited on the parent are rewired (on replay too)
   * to wait on the sub-graph's leaves, so the expansion keeps the task's
   * place in the plan. Guarded upstream: undispatched tasks only. */
  'plan.task.expanded': { planId: string; taskId: string; tasks: PlanTaskSpec[] }
  /** A snapshot of an isolated agent's worktree (a dangling git commit), so it
   * can be rewound to this point later. */
  'checkpoint.created': { sessionId: string; checkpointId: string; label: string; sha: string }
  /** An agent's worktree was rewound to a checkpoint. */
  'checkpoint.restored': { sessionId: string; checkpointId: string }
  /** The agent is asking the user to choose — answered via a follow-up. */
  'agent.question': {
    sessionId: string
    requestId: string
    questions: Array<{ question: string; options: string[] }>
  }
  /** A user message sent into an ongoing session (steering / reply).
   * imageCount is present (>0) when screenshots were attached — the bytes go to
   * the model, not the log; an added optional field keeps old logs replaying. */
  'user.message': { sessionId: string; text: string; imageCount?: number }
  'tool.called': { sessionId: string; callId: string; tool: string; input: unknown }
  'tool.resulted': { sessionId: string; callId: string; ok: boolean; output: string }
  'file.diffed': {
    sessionId: string
    path: string
    additions: number
    deletions: number
    patch: string
  }
  'cost.usage': {
    sessionId: string
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    usd: number
  }
  /** The account's billing posture (plan/limits/overage), sampled from the
   * provider — drives the status bar, not the per-session conversation. */
  'account.usage': { sessionId: string } & AccountUsage
  /** A live rate-limit signal (approaching or hit) pushed by the provider —
   * drives the capacity card. The manager stamps providerId so the card knows
   * which vendor's key a switch would use. */
  'account.limit': { sessionId: string; providerId?: string } & AccountLimit
  /** The harness captured a screenshot of the target app the agent is working
   * on — the visual feedback loop (Phase 2). The PNG bytes live in the artifact
   * store, not the log; `ref` points at them, keeping the log lean the same way
   * user.message keeps image bytes out. */
  'preview.captured': {
    sessionId: string
    ref: string
    url: string
    width: number
    height: number
    /** Console output (and any load failure) captured during the shot. Optional
     * so older logs without it still replay. */
    console?: ConsoleEntry[]
    /** Network requests the app made during the shot. Optional for the same
     * schema-evolution reason. */
    network?: NetworkEntry[]
  }
  /** A tool use is waiting on permission — the audit trail starts here. */
  'approval.requested': { sessionId: string; requestId: string; tool: string; input: unknown }
  'approval.resolved': {
    sessionId: string
    requestId: string
    approved: boolean
    via: 'allowlist' | 'user'
  }
  /** A spend ceiling (session or a time window) was crossed. */
  'budget.exceeded': {
    sessionId: string
    scope: import('./budget').BudgetScope
    usedUsd: number
    capUsd: number
  }
}

export type EventType = keyof EventPayloads

/** An event as it exists in the log: sequenced, timestamped, immutable. */
export interface StoredEvent<T extends EventType = EventType> {
  seq: number
  ts: string
  type: T
  payload: EventPayloads[T]
}
