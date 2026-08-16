import { createEntityId } from '../shared/events'
import type { EventPayloads, PipelineStageSpec, StoredEvent } from '../shared/events'
import type { EmitStored } from './approvals'
import type { WorktreeInfo } from './worktrees'

/** Prefixes the prior stage's output when it's handed to the next stage, so the
 * agent can tell the earlier work apart from its own instructions. */
export const HANDOFF_HEADER = '--- Output from the previous stage ---'

/** The built-in pipeline for a task: plan it, implement it, then review the
 * result. Each stage's prompt is the base instruction; the orchestrator appends
 * the previous stage's output as handoff context when it advances. */
export function defaultPipelineStages(task: string): PipelineStageSpec[] {
  return [
    {
      name: 'Plan',
      prompt:
        'You are the PLANNING stage of a pipeline. Do not edit, create, or run ' +
        'anything — a later stage implements your plan. Output only a written, ' +
        'ordered implementation plan: the files to change and the approach.\n\n' +
        `Task: ${task}`,
    },
    {
      name: 'Implement',
      prompt:
        'You are the IMPLEMENTATION stage. The plan is below. Implement the task ' +
        `in full, with tests.\n\nTask: ${task}`,
    },
    {
      name: 'Review',
      prompt:
        'You are the REVIEW stage. The implementation is already in this working ' +
        'tree — run `git diff` to see every change. Review it for correctness, ' +
        'test coverage, and style, and fix any problems you find.',
    },
  ]
}

/** What the orchestrator needs from the event store: a session's events, which
 * carry its `pipeline.stage.started` (so a finished session maps back to its
 * stage) and its `agent.text` (the output handed to the next stage). */
type PipelineReader = { listBySession(sessionId: string): StoredEvent[] }

/**
 * Runs multi-stage pipelines: dispatch stage 0 on create, then advance on each
 * stage's `session.ended` — the next stage's agent launches with the previous
 * stage's output appended as context, or the pipeline completes/halts. State
 * (each pipeline's stage list) lives in memory and is rebuilt from the log via
 * {@link reconcile} so a pipeline keeps advancing across a restart.
 */
export class PipelineOrchestrator {
  readonly #emit: EmitStored
  readonly #store: PipelineReader
  readonly #startStage: (prompt: string, worktree?: WorktreeInfo) => string
  readonly #retireStage: (sessionId: string) => void
  readonly #stagesByPipeline = new Map<string, PipelineStageSpec[]>()

  constructor(options: {
    emit: EmitStored
    store: PipelineReader
    startStage: (prompt: string, worktree?: WorktreeInfo) => string
    /** End a completed stage's agent so it leaves the rail (the pipeline chip
     * still shows its status). The worktree is left for the next stage. */
    retireStage: (sessionId: string) => void
  }) {
    this.#emit = options.emit
    this.#store = options.store
    this.#startStage = options.startStage
    this.#retireStage = options.retireStage
  }

  /** Launch a pipeline: record it, then dispatch its first stage. */
  create(title: string, stages: PipelineStageSpec[]): string {
    const pipelineId = createEntityId('pipeline')
    this.#stagesByPipeline.set(pipelineId, stages)
    this.#emit('pipeline.created', { pipelineId, title, stages })
    this.#dispatch(pipelineId, 0, stages[0].prompt)
    return pipelineId
  }

  /** Clear a pipeline from the list. It stops advancing (a still-running stage
   * that later finishes finds no definition and is left alone) and drops out of
   * the UI. */
  remove(pipelineId: string): void {
    this.#stagesByPipeline.delete(pipelineId)
    this.#emit('pipeline.removed', { pipelineId })
  }

  /** Rebuild in-memory pipeline definitions from the log (called at boot) so a
   * pipeline created before a restart still advances when its live stage ends.
   * A removed pipeline is forgotten so it neither advances nor reappears. */
  reconcile(events: StoredEvent[]): void {
    for (const event of events) {
      if (event.type === 'pipeline.created') {
        const payload = event.payload as EventPayloads['pipeline.created']
        this.#stagesByPipeline.set(payload.pipelineId, payload.stages)
      } else if (event.type === 'pipeline.removed') {
        this.#stagesByPipeline.delete(
          (event.payload as EventPayloads['pipeline.removed']).pipelineId,
        )
      }
    }
  }

  /**
   * Advance the owning pipeline when one of its stages' agents finishes. A stage
   * completes when its agent goes idle (a finished turn — agents stay alive
   * awaiting follow-ups, so a normal completion is `session.idle`, not
   * `session.ended`). A session that *ends* other than "completed" (cancelled or
   * failed) halts the pipeline.
   */
  observe(event: StoredEvent): void {
    if (event.type !== 'session.idle' && event.type !== 'session.ended') {
      return
    }
    const sessionId = (event.payload as { sessionId: string }).sessionId
    const events = this.#store.listBySession(sessionId)
    const started = events.find((e) => e.type === 'pipeline.stage.started')?.payload as
      EventPayloads['pipeline.stage.started'] | undefined
    if (started === undefined) {
      return // not a pipeline stage
    }
    // Idempotency: this stage already resolved (completed or failed) — don't
    // advance twice. Both carry the sessionId, so they're in the session index.
    if (events.some((e) => e.type === 'pipeline.stage.completed' || e.type === 'pipeline.failed')) {
      return
    }
    const { pipelineId, stageIndex } = started
    const stages = this.#stagesByPipeline.get(pipelineId)
    if (stages === undefined) {
      return // unknown pipeline — nothing to advance
    }
    if (
      event.type === 'session.ended' &&
      (event.payload as EventPayloads['session.ended']).outcome !== 'completed'
    ) {
      this.#emit('pipeline.failed', { pipelineId, stageIndex, sessionId })
      return
    }
    this.#emit('pipeline.stage.completed', { pipelineId, stageIndex, sessionId })
    // The stage is done — retire its agent so the rail isn't left with an idle
    // agent per finished stage (its transcript stays reachable via the chip).
    this.#retireStage(sessionId)
    const next = stageIndex + 1
    if (next >= stages.length) {
      this.#emit('pipeline.completed', { pipelineId })
      return
    }
    const handoff = this.#finalText(events)
    const prompt =
      handoff === ''
        ? stages[next].prompt
        : `${stages[next].prompt}\n\n${HANDOFF_HEADER}\n${handoff}`
    // Reuse the finishing stage's worktree so the next stage sees its edits —
    // implement builds on plan, review reads the actual diff.
    this.#dispatch(pipelineId, next, prompt, this.#worktreeOf(events))
  }

  /** Launch a stage's agent and link the resulting session to the stage. */
  #dispatch(pipelineId: string, stageIndex: number, prompt: string, worktree?: WorktreeInfo): void {
    const sessionId = this.#startStage(prompt, worktree)
    this.#emit('pipeline.stage.started', { pipelineId, stageIndex, sessionId })
  }

  /** The worktree the finishing stage ran in (from its session.started), or
   * undefined for a non-isolated provider — the next stage then runs the same
   * way (directly in the cwd). */
  #worktreeOf(events: StoredEvent[]): WorktreeInfo | undefined {
    const started = events.find((e) => e.type === 'session.started')?.payload as
      EventPayloads['session.started'] | undefined
    return started?.worktree
  }

  /** The last thing a stage's agent said — its output, handed to the next stage. */
  #finalText(events: StoredEvent[]): string {
    const texts = events.filter((e) => e.type === 'agent.text')
    const last = texts[texts.length - 1]?.payload as EventPayloads['agent.text'] | undefined
    return last?.text ?? ''
  }
}
