// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { InboxProvider } from '../state/inbox'
import { PipelineProvider } from '../state/pipelines'
import { PlanProvider } from '../state/plans'
import { QueueProvider } from '../state/queue'
import { ScrubProvider } from '../state/scrub'
import { SelectionProvider, useSelection } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { Panes } from './Panes'

function Pick({ kind }: { kind: 'plan' | 'session' }): React.JSX.Element {
  const { select } = useSelection()
  return (
    <button type="button" onClick={() => select({ kind, id: `${kind}_1` })}>
      pick {kind}
    </button>
  )
}

function renderPanes(children?: React.ReactNode): void {
  render(
    <SelectionProvider>
      <SessionsProvider>
        <QueueProvider>
          <PipelineProvider>
            <PlanProvider>
              <ScrubProvider>
                <InboxProvider>
                  {children}
                  <Panes />
                </InboxProvider>
              </ScrubProvider>
            </PlanProvider>
          </PipelineProvider>
        </QueueProvider>
      </SessionsProvider>
    </SelectionProvider>,
  )
}

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
  window.localStorage.clear()
})

describe('Panes', () => {
  it('swaps the centre pane to the plan canvas while a plan is selected', () => {
    renderPanes(
      <>
        <Pick kind="plan" />
        <Pick kind="session" />
      </>,
    )
    expect(screen.queryByRole('region', { name: 'Plan canvas' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'pick plan' }))
    expect(screen.getByRole('region', { name: 'Plan canvas' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()

    // Selecting an agent hands the centre back to the stream.
    fireEvent.click(screen.getByRole('button', { name: 'pick session' }))
    expect(screen.queryByRole('region', { name: 'Plan canvas' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument()
  })

  it('lays out rail · gutter · stream · gutter · inspector at default widths', () => {
    renderPanes()

    expect(columns()).toBe('176px 6px 1fr 6px 380px')
  })

  it('restores persisted widths on mount', () => {
    window.localStorage.setItem('agentinator:panes:rail', '200')
    window.localStorage.setItem('agentinator:panes:inspector', '300')

    renderPanes()

    expect(columns()).toBe('200px 6px 1fr 6px 300px')
  })

  it('clamps a persisted width that is out of range, and ignores a malformed one', () => {
    window.localStorage.setItem('agentinator:panes:rail', '9999')
    window.localStorage.setItem('agentinator:panes:inspector', 'not-a-number')

    renderPanes()

    // Rail clamps to its max; the malformed inspector value falls back to default.
    expect(columns()).toBe('320px 6px 1fr 6px 380px')
  })

  it('persists a resize so it survives a remount', () => {
    renderPanes()
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize agent rail' }), {
      key: 'ArrowRight',
    })
    expect(window.localStorage.getItem('agentinator:panes:rail')).toBe('192')

    renderPanes()
    expect(columns()).toBe('192px 6px 1fr 6px 380px')
  })

  it('resizes the rail and inspector with arrow keys', () => {
    renderPanes()

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize agent rail' }), {
      key: 'ArrowRight',
    })
    expect(columns()).toBe('192px 6px 1fr 6px 380px')

    // Dragging the inspector's gutter left (ArrowLeft → negative delta) grows it.
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize inspector' }), {
      key: 'ArrowLeft',
    })
    expect(columns()).toBe('192px 6px 1fr 6px 396px')
  })

  it('clamps the rail to its min and max when dragged past them', () => {
    renderPanes()

    drag('Resize agent rail', 100, -1000)
    expect(columns()).toBe('120px 6px 1fr 6px 380px')

    drag('Resize agent rail', 100, 1000)
    expect(columns()).toBe('320px 6px 1fr 6px 380px')
  })

  it('clamps the inspector to its min and max when dragged past them', () => {
    renderPanes()

    drag('Resize inspector', 100, 1000)
    expect(columns()).toBe('176px 6px 1fr 6px 260px')

    drag('Resize inspector', 100, -1000)
    expect(columns()).toBe('176px 6px 1fr 6px 680px')
  })
})
