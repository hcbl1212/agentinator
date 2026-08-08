// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Panes } from './Panes'

function columns(): string {
  return (document.querySelector('.panes') as HTMLElement).style.gridTemplateColumns
}

function drag(sepName: string, fromX: number, toX: number): void {
  const sep = screen.getByRole('separator', { name: sepName })
  fireEvent.mouseDown(sep, { clientX: fromX })
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: toX }))
  })
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup'))
  })
}

afterEach(() => {
  delete window.agentinator
})

describe('Panes', () => {
  it('lays out rail · gutter · stream · gutter · inspector at default widths', () => {
    render(<Panes />)

    expect(columns()).toBe('52px 6px 1fr 6px 380px')
  })

  it('resizes the rail and inspector with arrow keys', () => {
    render(<Panes />)

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize agent rail' }), {
      key: 'ArrowRight',
    })
    expect(columns()).toBe('68px 6px 1fr 6px 380px')

    // Dragging the inspector's gutter left (ArrowLeft → negative delta) grows it.
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize inspector' }), {
      key: 'ArrowLeft',
    })
    expect(columns()).toBe('68px 6px 1fr 6px 396px')
  })

  it('clamps the rail to its min and max when dragged past them', () => {
    render(<Panes />)

    drag('Resize agent rail', 100, -1000)
    expect(columns()).toBe('44px 6px 1fr 6px 380px')

    drag('Resize agent rail', 100, 1000)
    expect(columns()).toBe('240px 6px 1fr 6px 380px')
  })

  it('clamps the inspector to its min and max when dragged past them', () => {
    render(<Panes />)

    // Drag the gutter right → inspector shrinks to its floor.
    drag('Resize inspector', 100, 1000)
    expect(columns()).toBe('52px 6px 1fr 6px 260px')

    // Drag left → inspector grows to its ceiling.
    drag('Resize inspector', 100, -1000)
    expect(columns()).toBe('52px 6px 1fr 6px 680px')
  })
})
