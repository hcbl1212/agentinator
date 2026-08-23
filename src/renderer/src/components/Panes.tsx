import { useEffect, useState } from 'react'

import { AgentRail } from './AgentRail'
import { Inspector } from './Inspector'
import { PaneGutter } from './PaneGutter'
import { Pipelines } from './Pipelines'
import { Planner } from './Planner'
import { Stream } from './Stream'
import { TaskQueue } from './TaskQueue'

const RAIL_MIN = 120
const RAIL_MAX = 320
const INSPECTOR_MIN = 260
const INSPECTOR_MAX = 680

const RAIL_KEY = 'agentinator:panes:rail'
const INSPECTOR_KEY = 'agentinator:panes:inspector'

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** A persisted width, clamped into range; falls back if missing or malformed. */
function storedWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = window.localStorage.getItem(key)
  const parsed = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback
}

/**
 * The resizable pane grid: a slim agent rail, the unified stream (the flexible
 * middle), and the Diff/Preview inspector, split by draggable gutters. Only the
 * two side columns carry a width; the stream absorbs the rest, so dragging
 * either gutter redistributes space across all three.
 */
export function Panes(): React.JSX.Element {
  const [railWidth, setRailWidth] = useState(() => storedWidth(RAIL_KEY, 176, RAIL_MIN, RAIL_MAX))
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    storedWidth(INSPECTOR_KEY, 380, INSPECTOR_MIN, INSPECTOR_MAX),
  )

  // Widths survive reloads (the plan's "saved layouts", v1).
  useEffect(() => {
    window.localStorage.setItem(RAIL_KEY, String(railWidth))
  }, [railWidth])
  useEffect(() => {
    window.localStorage.setItem(INSPECTOR_KEY, String(inspectorWidth))
  }, [inspectorWidth])

  const resizeRail = (delta: number): void => {
    setRailWidth((width) => clamp(width + delta, RAIL_MIN, RAIL_MAX))
  }
  const resizeInspector = (delta: number): void => {
    // The inspector sits on the right, so dragging its gutter left (negative
    // delta) grows it.
    setInspectorWidth((width) => clamp(width - delta, INSPECTOR_MIN, INSPECTOR_MAX))
  }

  return (
    <div
      className="panes"
      style={{ gridTemplateColumns: `${railWidth}px 6px 1fr 6px ${inspectorWidth}px` }}
    >
      <div className="rail-col">
        <Planner />
        <TaskQueue />
        <Pipelines />
        <AgentRail />
      </div>
      <PaneGutter label="Resize agent rail" onResize={resizeRail} />
      <Stream />
      <PaneGutter label="Resize inspector" onResize={resizeInspector} />
      <Inspector />
    </div>
  )
}
