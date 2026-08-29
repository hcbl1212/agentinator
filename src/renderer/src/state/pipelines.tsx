import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { EventPayloads, StoredEvent } from '../../../shared/events'

/** A stage as the UI shows it: its label, how far along it is, and (once it has
 * launched) the agent session running it — so a click can jump to that agent. */
export interface PipelineStageView {
  name: string
  status: 'pending' | 'running' | 'done' | 'failed'
  sessionId?: string
  /** The model this stage is routed to, if it overrides the default. */
  model?: string
}

/** A pipeline reduced from the log: its stages in order, whether it finished,
 * and whether the user has signed off on the review. */
export interface Pipeline {
  id: string
  title: string
  stages: PipelineStageView[]
  done: boolean
  approved: boolean
}

/** Replace one pipeline's stage at `index` via `patch`, leaving the rest alone. */
function patchStage(
  pipelines: Pipeline[],
  pipelineId: string,
  index: number,
  patch: Partial<PipelineStageView>,
): Pipeline[] {
  return pipelines.map((pipeline) =>
    pipeline.id === pipelineId
      ? {
          ...pipeline,
          stages: pipeline.stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)),
        }
      : pipeline,
  )
}

/**
 * Folds one event into the pipeline list: a pipeline appears when created (all
 * stages pending), each stage flips to running/done/failed as its agent starts
 * and ends, and the pipeline is marked done when the last stage completes.
 */
export function reducePipelines(pipelines: Pipeline[], event: StoredEvent): Pipeline[] {
  switch (event.type) {
    case 'pipeline.created': {
      const payload = event.payload as EventPayloads['pipeline.created']
      return pipelines.some((pipeline) => pipeline.id === payload.pipelineId)
        ? pipelines
        : [
            ...pipelines,
            {
              id: payload.pipelineId,
              title: payload.title,
              stages: payload.stages.map((stage) => ({
                name: stage.name,
                status: 'pending',
                ...(stage.model === undefined ? {} : { model: stage.model }),
              })),
              done: false,
              approved: false,
            },
          ]
    }
    case 'pipeline.stage.started': {
      const { pipelineId, stageIndex, sessionId } =
        event.payload as EventPayloads['pipeline.stage.started']
      return patchStage(pipelines, pipelineId, stageIndex, { status: 'running', sessionId })
    }
    case 'pipeline.stage.completed': {
      const { pipelineId, stageIndex } = event.payload as EventPayloads['pipeline.stage.completed']
      return patchStage(pipelines, pipelineId, stageIndex, { status: 'done' })
    }
    case 'pipeline.failed': {
      const { pipelineId, stageIndex } = event.payload as EventPayloads['pipeline.failed']
      return patchStage(pipelines, pipelineId, stageIndex, { status: 'failed' })
    }
    case 'pipeline.completed': {
      const { pipelineId } = event.payload as EventPayloads['pipeline.completed']
      return pipelines.map((pipeline) =>
        pipeline.id === pipelineId ? { ...pipeline, done: true } : pipeline,
      )
    }
    case 'pipeline.approved': {
      const { pipelineId } = event.payload as EventPayloads['pipeline.approved']
      return pipelines.map((pipeline) =>
        pipeline.id === pipelineId ? { ...pipeline, approved: true } : pipeline,
      )
    }
    case 'pipeline.removed': {
      const { pipelineId } = event.payload as EventPayloads['pipeline.removed']
      return pipelines.filter((pipeline) => pipeline.id !== pipelineId)
    }
    default:
      return pipelines
  }
}

/** The human decision a pipeline is waiting on, if any. Both boundaries carry
 * the just-finished stage's session (its output is what you're judging):
 *  · gate — a stage finished with more to come: Continue or Revise it.
 *  · review — every stage finished, not yet signed off: Approve, or Request
 *    changes (re-runs the final stage). Mutually exclusive. */
export interface PipelineBoundary {
  gate?: { from: string; stageName: string; nextName: string }
  review?: { from: string; stageName: string }
}

export function pipelineBoundary(pipeline: Pipeline): PipelineBoundary {
  const running = pipeline.stages.some((stage) => stage.status === 'running')
  const failed = pipeline.stages.some((stage) => stage.status === 'failed')
  const doneStages = pipeline.stages.filter((stage) => stage.status === 'done')
  const lastDone = doneStages[doneStages.length - 1]
  const nextStage = pipeline.stages.find((stage) => stage.status === 'pending')
  const allDone = pipeline.stages.every((stage) => stage.status === 'done')
  return {
    gate:
      !pipeline.done &&
      !running &&
      !failed &&
      lastDone?.sessionId !== undefined &&
      nextStage !== undefined
        ? { from: lastDone.sessionId, stageName: lastDone.name, nextName: nextStage.name }
        : undefined,
    review:
      lastDone?.sessionId !== undefined && allDone && !pipeline.approved
        ? { from: lastDone.sessionId, stageName: lastDone.name }
        : undefined,
  }
}

interface PipelineState {
  pipelines: Pipeline[]
}

const PipelineContext = createContext<PipelineState | null>(null)

/** Derives the pipeline list from the append-only log and shares it. */
export function PipelineProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [pipelines, setPipelines] = useState<Pipeline[]>([])

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.tail(500).then((page) => {
      if (!cancelled) {
        setPipelines((previous) => page.reduce(reducePipelines, previous))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setPipelines((previous) => reducePipelines(previous, event))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo(() => ({ pipelines }), [pipelines])
  return <PipelineContext.Provider value={value}>{children}</PipelineContext.Provider>
}

export function usePipelines(): PipelineState {
  const state = useContext(PipelineContext)
  if (state === null) {
    throw new Error('usePipelines must be used within a PipelineProvider')
  }
  return state
}
