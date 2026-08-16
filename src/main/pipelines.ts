import { createEntityId } from '../shared/events'
import type { EventPayloads, PipelineStageSpec, StoredEvent } from '../shared/events'
import type { EmitStored } from './approvals'
import type { WorktreeInfo } from './worktrees'

/** Prefixes the prior stage's output when it's handed to the next stage, so the
 * agent can tell the earlier work apart from its own instructions. */
export const HANDOFF_HEADER = '--- Output from the previous stage ---'

/** Prefixes a stage's own prior attempt when it's re-run with revisions. */
export const PRIOR_ATTEMPT_HEADER = '--- Your previous attempt ---'

/** Prefixes the user's revision feedback on a re-run of a stage. */
export const REVISION_HEADER = '--- Revise it per this feedback ---'

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
 * Runs multi-stage pipelines: dispatch stage 0 on create, then pause at each
 * stage boundary (a human-in-the-loop gate) — when a stage's agent finishes, it
 * records the completion and waits. {@link continueStage} launches the next
 * stage, handing the finished stage's output and shared worktree forward. A
 * failed/cancelled stage halts the pipeline. State lives in memory and is
 * rebuilt from the log via {@link reconcile} so a paused pipeline survives a
 * restart.
 */
export class PipelineOrchestrator {
  readonly #emit: EmitStored
  readonly #store: PipelineReader
  readonly #startStage: (prompt: string, worktree?: WorktreeInfo) => string
  readonly #retireStage: (sessionId: string) => void
  readonly #stagesByPipeline = new Map<string, PipelineStageSpec[]>()
  /** `${pipelineId}:${stageIndex}` for every stage already dispatched, so a
   * double Continue can't launch the same stage twice. */
  readonly #startedStages = new Set<string>()

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

  /** Continue a paused pipeline: dispatch the stage after the one whose agent
   * finished (`fromSessionId`), handing its output and shared worktree forward.
   * The renderer supplies the finished stage, so no gate state has to be
   * reconstructed here. A no-op if the pipeline was removed, the stage was the
   * last, or the next stage already started (a double Continue). */
  continueStage(pipelineId: string, fromSessionId: string): void {
    const stages = this.#stagesByPipeline.get(pipelineId)
    if (stages === undefined) {
      return
    }
    const events = this.#store.listBySession(fromSessionId)
    const started = events.find((e) => e.type === 'pipeline.stage.started')?.payload as
      EventPayloads['pipeline.stage.started'] | undefined
    if (started === undefined) {
      return
    }
    const next = started.stageIndex + 1
    if (next >= stages.length || this.#startedStages.has(`${pipelineId}:${next}`)) {
      return
    }
    const handoff = this.#finalText(events)
    const prompt =
      handoff === ''
        ? stages[next].prompt
        : `${stages[next].prompt}\n\n${HANDOFF_HEADER}\n${handoff}`
    this.#dispatch(pipelineId, next, prompt, this.#worktreeOf(events))
  }

  /** Re-run a paused stage with the user's revision feedback (e.g. reshape the
   * plan before implementing). Dispatches the same stage again — its prior
   * attempt and the feedback are handed to a fresh agent, in the same worktree.
   * A no-op if the pipeline was removed, the stage never ran, or the pipeline
   * already advanced past this boundary. */
  reviseStage(pipelineId: string, fromSessionId: string, feedback: string): void {
    const stages = this.#stagesByPipeline.get(pipelineId)
    if (stages === undefined) {
      return
    }
    const events = this.#store.listBySession(fromSessionId)
    const started = events.find((e) => e.type === 'pipeline.stage.started')?.payload as
      EventPayloads['pipeline.stage.started'] | undefined
    if (
      started === undefined ||
      this.#startedStages.has(`${pipelineId}:${started.stageIndex + 1}`)
    ) {
      return
    }
    const previous = this.#finalText(events)
    const parts = [stages[started.stageIndex].prompt]
    if (previous !== '') {
      parts.push(`${PRIOR_ATTEMPT_HEADER}\n${previous}`)
    }
    parts.push(`${REVISION_HEADER}\n${feedback}`)
    this.#dispatch(pipelineId, started.stageIndex, parts.join('\n\n'), this.#worktreeOf(events))
  }

  /** Rebuild in-memory pipeline state from the log (called at boot) so a
   * pipeline paused before a restart can still be continued. A removed pipeline
   * is forgotten so it neither advances nor reappears. */
  reconcile(events: StoredEvent[]): void {
    for (const event of events) {
      if (event.type === 'pipeline.created') {
        const payload = event.payload as EventPayloads['pipeline.created']
        this.#stagesByPipeline.set(payload.pipelineId, payload.stages)
      } else if (event.type === 'pipeline.removed') {
        this.#stagesByPipeline.delete(
          (event.payload as EventPayloads['pipeline.removed']).pipelineId,
        )
      } else if (event.type === 'pipeline.stage.started') {
        const { pipelineId, stageIndex } = event.payload as EventPayloads['pipeline.stage.started']
        this.#startedStages.add(`${pipelineId}:${stageIndex}`)
      }
    }
  }

  /**
   * React to a stage's agent finishing. A stage completes when its agent goes
   * idle (a finished turn — agents stay alive awaiting follow-ups, so a normal
   * completion is `session.idle`, not `session.ended`): the stage is recorded
   * completed and retired, then the pipeline pauses at the gate (or completes if
   * it was the last stage) — {@link continueStage} launches the next one. A
   * session that *ends* other than "completed" (cancelled or failed) halts it.
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
    // Stop at the boundary: the last stage completes the pipeline, otherwise it
    // pauses for the user to review this stage's output and press Continue (the
    // human-in-the-loop gate) — the next stage does not auto-start.
    if (stageIndex + 1 >= stages.length) {
      this.#emit('pipeline.completed', { pipelineId })
    }
  }

  /** Launch a stage's agent and link the resulting session to the stage. */
  #dispatch(pipelineId: string, stageIndex: number, prompt: string, worktree?: WorktreeInfo): void {
    const sessionId = this.#startStage(prompt, worktree)
    this.#startedStages.add(`${pipelineId}:${stageIndex}`)
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
