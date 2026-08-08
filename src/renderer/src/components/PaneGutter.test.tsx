// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PaneGutter } from './PaneGutter'

function move(clientX: number): void {
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX }))
  })
}

function mouseUp(): void {
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup'))
  })
}

describe('PaneGutter', () => {
  it('exposes an accessible vertical separator', () => {
    render(<PaneGutter label="Resize rail" onResize={vi.fn()} />)

    const gutter = screen.getByRole('separator', { name: 'Resize rail' })
    expect(gutter).toHaveAttribute('aria-orientation', 'vertical')
  })

  it('nudges by a fixed step on arrow keys and ignores other keys', () => {
    const onResize = vi.fn()
    render(<PaneGutter label="Resize rail" onResize={onResize} />)
    const gutter = screen.getByRole('separator', { name: 'Resize rail' })

    fireEvent.keyDown(gutter, { key: 'ArrowRight' })
    fireEvent.keyDown(gutter, { key: 'ArrowLeft' })
    fireEvent.keyDown(gutter, { key: 'Enter' })

    expect(onResize.mock.calls).toEqual([[16], [-16]])
  })

  it('reports incremental drag deltas until the mouse is released', () => {
    const onResize = vi.fn()
    render(<PaneGutter label="Resize rail" onResize={onResize} />)
    const gutter = screen.getByRole('separator', { name: 'Resize rail' })

    fireEvent.mouseDown(gutter, { clientX: 100 })
    move(130)
    move(120)
    expect(onResize.mock.calls).toEqual([[30], [-10]])

    mouseUp()
    // After release the window listeners are gone, so further motion is silent.
    move(400)
    expect(onResize).toHaveBeenCalledTimes(2)
  })
})
