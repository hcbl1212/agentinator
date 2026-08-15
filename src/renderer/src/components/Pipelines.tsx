import { usePipelines } from '../state/pipelines'
import type { PipelineStageView } from '../state/pipelines'
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
 * agent works; clicking a launched stage selects its agent so the stream and
 * inspector follow it. Fed live from the event log.
 */
export function Pipelines(): React.JSX.Element {
  const { pipelines } = usePipelines()
  const { select } = useSelection()

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
            <li key={pipeline.id} className="pipeline-row">
              <span className="pipeline-title" title={pipeline.title}>
                {pipeline.title}
              </span>
              <ol className="pipeline-stages">
                {pipeline.stages.map((stage, index) => {
                  const label = `${stage.name} — ${stage.status}`
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
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
