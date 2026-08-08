import { useState } from 'react'

import { AgentRail } from './AgentRail'
import { Inspector } from './Inspector'
import { PaneGutter } from './PaneGutter'
import { Stream } from './Stream'

const RAIL_MIN = 44
const RAIL_MAX = 240
const INSPECTOR_MIN = 260
const INSPECTOR_MAX = 680

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * The resizable pane grid: a slim agent rail, the unified stream (the flexible
 * middle), and the Diff/Preview inspector, split by draggable gutters. Only the
 * two side columns carry a width; the stream absorbs the rest, so dragging
 * either gutter redistributes space across all three.
 */
export function Panes(): React.JSX.Element {
  const [railWidth, setRailWidth] = useState(52)
  const [inspectorWidth, setInspectorWidth] = useState(380)

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
      <AgentRail />
      <PaneGutter label="Resize agent rail" onResize={resizeRail} />
      <Stream />
      <PaneGutter label="Resize inspector" onResize={resizeInspector} />
      <Inspector />
    </div>
  )
}
