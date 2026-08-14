// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { useSelection } from '../state/selection'
import { SelectionProvider } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { Inspector } from './Inspector'

function renderInspector(): void {
  render(
    <SelectionProvider>
      <Inspector />
    </SelectionProvider>,
  )
}

function Selector(): React.JSX.Element {
  const { select } = useSelection()
  return (
    <button type="button" onClick={() => select({ kind: 'session', id: 'x' })}>
      pick x
    </button>
  )
}

afterEach(() => {
  delete window.agentinator
})

describe('Inspector', () => {
  it('shows the diff tab by default, scoped to the selection', () => {
    renderInspector()

    expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument()
    // With no agent selected, the diff prompts to pick one.
    expect(screen.getByText(/Select an agent to see its changes/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'App preview' })).not.toBeInTheDocument()
  })

  it('switches to the checkpoints tab', async () => {
    const user = userEvent.setup()
    render(
      <SelectionProvider>
        <SessionsProvider>
          <Inspector />
        </SessionsProvider>
      </SelectionProvider>,
    )

    await user.click(screen.getByRole('tab', { name: 'Checkpoints' }))

    expect(screen.getByRole('tab', { name: 'Checkpoints' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText(/Select an agent to snapshot its work/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Diff' })).not.toBeInTheDocument()
  })

  it('switches to the preview tab and back', async () => {
    const user = userEvent.setup()
    renderInspector()

    await user.click(screen.getByRole('tab', { name: 'Preview' }))

    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'App preview' })).toBeInTheDocument()
    expect(screen.getByText(/Select an agent to preview its app/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Diff' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Diff' }))
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument()
  })

  it('scopes to the selected agent', async () => {
    const user = userEvent.setup()
    render(
      <SelectionProvider>
        <Selector />
        <Inspector />
      </SelectionProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'pick x' }))

    // With an agent selected the diff waits on its edits rather than prompting.
    expect(screen.getByText(/File changes appear here as the agent edits/)).toBeInTheDocument()
  })
})
