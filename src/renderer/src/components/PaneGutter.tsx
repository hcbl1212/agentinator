import { useEffect, useRef, useState } from 'react'

/** Keyboard nudge per arrow press, in pixels. */
const STEP = 16

/**
 * A draggable separator between two panes. Reports the horizontal drag delta
 * (pixels moved since the last event) to onResize; the parent decides which
 * pane the delta grows or shrinks. Arrow keys nudge it too, so resizing is
 * reachable without a mouse.
 */
export function PaneGutter({
  label,
  onResize,
}: {
  label: string
  onResize: (deltaX: number) => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const lastX = useRef(0)

  useEffect(() => {
    if (!dragging) {
      return
    }
    const onMove = (moveEvent: MouseEvent): void => {
      const delta = moveEvent.clientX - lastX.current
      lastX.current = moveEvent.clientX
      onResize(delta)
    }
    const onUp = (): void => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, onResize])

  const onMouseDown = (downEvent: React.MouseEvent): void => {
    lastX.current = downEvent.clientX
    setDragging(true)
  }

  const onKeyDown = (keyEvent: React.KeyboardEvent): void => {
    if (keyEvent.key === 'ArrowRight') {
      onResize(STEP)
    } else if (keyEvent.key === 'ArrowLeft') {
      onResize(-STEP)
    }
  }

  return (
    <div
      className={`pane-gutter${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  )
}
