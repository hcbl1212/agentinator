import { useState } from 'react'

import { pipelineBoundary, usePipelines } from '../state/pipelines'
import type { Pipeline, PipelineStageView } from '../state/pipelines'
import { useSelection } from '../state/selection'

/** The glyph that encodes a stage's state in form as well as colour. */
const STAGE_MARK: Record<PipelineStageView['status'], string> = {
  pending: '○',
  running: '◐',
  done: '●',
  failed: '✕',
}

/**
 * The pipelines pane: each running or finished pipeline as a row of stage chips
 * (Plan → Implement → Review). A stage flips pending → running → done as its
 * agent works; clicking a launched stage selects its agent (focus-follows). At a
 * boundary the pipeline pauses for review — Continue advances, or Revise re-runs
 * that stage with feedback. Fed live from the event log.
 */
export function Pipelines(): React.JSX.Element {
  const { pipelines } = usePipelines()

  return (
    <section className="pane pipelines" aria-label="Pipelines">
      <div className="rail-head">
        <h2 className="pane-label">Pipelines</h2>
        {pipelines.length > 0 && <span className="queue-count">{pipelines.length}</span>}
      </div>
      {pipelines.length === 0 ? (
        <p className="rail-empty">
          No pipelines yet. Press Pipeline in the composer to chain plan → implement → review.
        </p>
      ) : (
        <ul className="pipeline-list">
          {pipelines.map((pipeline) => (
            <PipelineRow key={pipeline.id} pipeline={pipeline} />
          ))}
        </ul>
      )}
    </section>
  )
}

function PipelineRow({ pipeline }: { pipeline: Pipeline }): React.JSX.Element {
  const { select } = useSelection()
  const [feedback, setFeedback] = useState('')
  const { gate, review } = pipelineBoundary(pipeline)

  const revise = (from: string): void => {
    const trimmed = feedback.trim()
    if (trimmed === '') {
      return
    }
    void window.agentinator?.pipelines.revise(pipeline.id, from, trimmed)
    setFeedback('')
  }

  return (
    <li className="pipeline-row">
      <div className="pipeline-head">
        <button
          type="button"
          className="pipeline-title plan-title-button"
          title={`${pipeline.title} — open the review workbench`}
          aria-label={`Review pipeline ${pipeline.title}`}
          onClick={() => select({ kind: 'pipeline', id: pipeline.id })}
        >
          {pipeline.title}
        </button>
        <button
          type="button"
          className="queue-action"
          aria-label={`Clear pipeline ${pipeline.title}`}
          title="Clear this pipeline"
          onClick={() => void window.agentinator?.pipelines.remove(pipeline.id)}
        >
          ✕
        </button>
      </div>
      <ol className="pipeline-stages">
        {pipeline.stages.map((stage, index) => {
          const label =
            `${stage.name} — ${stage.status}` +
            (stage.model === undefined ? '' : ` · ${stage.model}`)
          const className = `pipeline-stage is-${stage.status}`
          return (
            <li key={index} className="pipeline-stage-item">
              {stage.sessionId === undefined ? (
                <span className={className} title={label} aria-label={label}>
                  <span className="pipeline-stage-mark" aria-hidden="true">
                    {STAGE_MARK[stage.status]}
                  </span>
                  {stage.name}
                </span>
              ) : (
                <button
                  type="button"
                  className={className}
                  title={`${label} — select its agent`}
                  aria-label={`${label} — select its agent`}
                  onClick={() => select({ kind: 'session', id: stage.sessionId as string })}
                >
                  <span className="pipeline-stage-mark" aria-hidden="true">
                    {STAGE_MARK[stage.status]}
                  </span>
                  {stage.name}
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {gate !== undefined && (
        <div className="pipeline-gate">
          <form
            className="pipeline-revise"
            onSubmit={(event) => {
              event.preventDefault()
              revise(gate.from)
            }}
          >
            <input
              className="pipeline-revise-input"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={`Revise ${gate.stageName}…`}
              aria-label={`Revision feedback for ${gate.stageName}`}
            />
            <button type="submit" className="pipeline-revise-send">
              Revise
            </button>
          </form>
          <button
            type="button"
            className="pipeline-continue"
            onClick={() => void window.agentinator?.pipelines.continue(pipeline.id, gate.from)}
          >
            Continue → {gate.nextName}
          </button>
        </div>
      )}
      {review !== undefined && (
        <div className="pipeline-gate">
          <form
            className="pipeline-revise"
            onSubmit={(event) => {
              event.preventDefault()
              revise(review.from)
            }}
          >
            <input
              className="pipeline-revise-input"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="Request changes…"
              aria-label="Request changes on this pipeline"
            />
            <button type="submit" className="pipeline-revise-send">
              Request changes
            </button>
          </form>
          <button
            type="button"
            className="pipeline-continue"
            onClick={() => void window.agentinator?.pipelines.approve(pipeline.id)}
          >
            Approve ✓
          </button>
        </div>
      )}
      {pipeline.approved && (
        <span className="pipeline-approved" role="status">
          ✓ Approved
        </span>
      )}
    </li>
  )
}
