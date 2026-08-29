import { useEffect, useState } from 'react'

import type { EventPayloads, StoredEvent } from '../../../shared/events'
import { toFileDiffs } from '../diff/diffFormat'
import { pipelineBoundary, usePipelines } from '../state/pipelines'
import type { PipelineStageView } from '../state/pipelines'
import { usePlans } from '../state/plans'
import { useSelection } from '../state/selection'
import { DiffFiles } from './DiffView'
import { FormattedText } from './FormattedText'

/** What the workbench gathers per launched stage: its final words (the
 * reasoning handed forward) and its share of the diff. */
interface StageReport {
  sessionId: string
  reasoning: string
  diffs: StoredEvent[]
}

/** The last thing a stage's agent said — its output/reasoning, the same text
 * the orchestrator hands to the next stage. */
export function finalText(events: StoredEvent[]): string {
  const texts = events.filter((event) => event.type === 'agent.text')
  const last = texts[texts.length - 1]?.payload as EventPayloads['agent.text'] | undefined
  return last?.text ?? ''
}

/**
 * The review workbench (the centre pane, via a pipeline selection): a
 * pipeline's work presented for judgement, not just spectating. Each launched
 * stage shows its reasoning — the words it handed forward — and beneath them
 * sits the pipeline's combined diff (newest change per file across all its
 * stages, later stages winning). The decision the pipeline is waiting on
 * lives here too: Continue/Revise at a gate, Approve/Request-changes at the
 * end — the same actions as the rail, with the evidence attached.
 */
export function ReviewWorkbench({ pipelineId }: { pipelineId: string }): React.JSX.Element {
  const { pipelines } = usePipelines()
  const { plans } = usePlans()
  const { select, clear } = useSelection()
  const [feedback, setFeedback] = useState('')
  const [promoting, setPromoting] = useState(false)
  const [reports, setReports] = useState<Map<string, StageReport>>(new Map())

  const pipeline = pipelines.find((candidate) => candidate.id === pipelineId)
  // Promotion only makes sense when a plan task launched this pipeline —
  // the written plan then takes that task's place in the DAG.
  const promotable = plans.some((plan) => plan.tasks.some((task) => task.pipelineId === pipelineId))

  const promoteFrom = (reasoning: string): void => {
    setPromoting(true)
    void window.agentinator?.planner
      .promote(pipelineId, reasoning)
      .catch(() => false)
      .then((promoted) => {
        setPromoting(false)
        if (promoted === true) {
          // The pipeline is gone and the DAG changed — show the canvas.
          clear()
        }
      })
  }
  const stageSessions = (pipeline?.stages ?? [])
    .map((stage) => stage.sessionId)
    .filter((sessionId): sessionId is string => sessionId !== undefined)
  const sessionsKey = stageSessions.join(',')

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    const sessions = sessionsKey === '' ? [] : sessionsKey.split(',')
    void Promise.all(
      sessions.map(async (sessionId) => {
        const [events, diffs] = await Promise.all([
          bridge.events.bySession(sessionId),
          bridge.events.diffs(sessionId),
        ])
        return { sessionId, reasoning: finalText(events), diffs }
      }),
    ).then((loaded) => {
      if (!cancelled) {
        setReports(new Map(loaded.map((report) => [report.sessionId, report])))
      }
    })
    return () => {
      cancelled = true
    }
    // Reload when a stage starts or finishes (the session list changes) — a
    // finished stage's reasoning/diff is stable, so that's the right cadence.
  }, [sessionsKey])

  if (pipeline === undefined) {
    return (
      <section className="review-workbench" aria-label="Review workbench">
        <p className="rail-empty">This pipeline is gone — it was cleared from the rail.</p>
      </section>
    )
  }

  const { gate, review } = pipelineBoundary(pipeline)
  // Later stages come later in stage order, so folding newest-per-path keeps
  // the pipeline's final word on every file.
  const byPath = new Map<string, StoredEvent>()
  for (const sessionId of stageSessions) {
    for (const diff of reports.get(sessionId)?.diffs ?? []) {
      byPath.set((diff.payload as EventPayloads['file.diffed']).path, diff)
    }
  }
  const files = toFileDiffs([...byPath.values()])

  const revise = (from: string): void => {
    const trimmed = feedback.trim()
    if (trimmed === '') {
      return
    }
    void window.agentinator?.pipelines.revise(pipeline.id, from, trimmed)
    setFeedback('')
  }

  const startedStages = pipeline.stages.filter(
    (stage): stage is PipelineStageView & { sessionId: string } => stage.sessionId !== undefined,
  )

  return (
    <section className="review-workbench" aria-label="Review workbench">
      <div className="plan-canvas-head">
        <span className="pipeline-title" title={pipeline.title}>
          {pipeline.title}
        </span>
        <span className="plan-task-detail-meta">
          {pipeline.approved ? 'approved' : pipeline.done ? 'awaiting review' : 'in flight'}
        </span>
        <button
          type="button"
          className="queue-action review-close"
          aria-label="Close review"
          title="Back to the plan / stream"
          onClick={() => clear()}
        >
          ✕
        </button>
      </div>
      <div className="review-body">
        {startedStages.map((stage) => (
          <section
            key={stage.sessionId}
            className="review-stage"
            aria-label={`Stage: ${stage.name}`}
          >
            <header className="review-stage-head">
              <span className="review-stage-name">
                {stage.name} — {stage.status}
              </span>
              <button
                type="button"
                className="queue-action"
                aria-label={`Open ${stage.name} transcript`}
                title="Open this stage's full transcript"
                onClick={() => select({ kind: 'session', id: stage.sessionId })}
              >
                ▤
              </button>
              {promotable && (reports.get(stage.sessionId)?.reasoning ?? '') !== '' && (
                <button
                  type="button"
                  className="plan-form-send review-promote"
                  disabled={promoting}
                  aria-label={`Promote ${stage.name} output to plan tasks`}
                  title="Turn this stage's written plan into DAG tasks, in the pipelined task's place"
                  onClick={() => promoteFrom(reports.get(stage.sessionId)?.reasoning as string)}
                >
                  {promoting ? 'Promoting…' : 'Promote to plan tasks'}
                </button>
              )}
            </header>
            {reports.get(stage.sessionId) !== undefined && (
              <div className="review-reasoning">
                <FormattedText
                  text={
                    reports.get(stage.sessionId)?.reasoning === ''
                      ? '(no written output)'
                      : (reports.get(stage.sessionId)?.reasoning as string)
                  }
                />
              </div>
            )}
          </section>
        ))}
        {files.length > 0 && (
          <section className="review-diff" aria-label="Combined diff">
            <header className="review-stage-head">
              <span className="review-stage-name">Changes — every file, final state</span>
            </header>
            <DiffFiles files={files} />
          </section>
        )}
      </div>
      {(gate !== undefined || review !== undefined) && (
        <div className="pipeline-gate review-actions">
          <form
            className="pipeline-revise"
            onSubmit={(event) => {
              event.preventDefault()
              revise((gate ?? review)?.from as string)
            }}
          >
            <input
              className="pipeline-revise-input"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={gate !== undefined ? `Revise ${gate.stageName}…` : 'Request changes…'}
              aria-label={
                gate !== undefined
                  ? `Revision feedback for ${gate.stageName}`
                  : 'Request changes on this pipeline'
              }
            />
            <button type="submit" className="pipeline-revise-send">
              {gate !== undefined ? 'Revise' : 'Request changes'}
            </button>
          </form>
          {gate !== undefined ? (
            <button
              type="button"
              className="pipeline-continue"
              onClick={() => void window.agentinator?.pipelines.continue(pipeline.id, gate.from)}
            >
              Continue → {gate.nextName}
            </button>
          ) : (
            review !== undefined && (
              <button
                type="button"
                className="pipeline-continue"
                onClick={() => void window.agentinator?.pipelines.approve(pipeline.id)}
              >
                Approve ✓
              </button>
            )
          )}
        </div>
      )}
    </section>
  )
}
