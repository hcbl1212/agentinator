// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { Workspace } from './Workspace'

afterEach(() => {
  delete window.agentinator
})

describe('Workspace', () => {
  it('shows the timeline tab by default', () => {
    render(<Workspace />)

    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Activity timeline' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Diff' })).not.toBeInTheDocument()
  })

  it('switches to the diff tab and back', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    await user.click(screen.getByRole('tab', { name: 'Diff' }))

    expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Activity timeline' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Timeline' }))
    expect(screen.getByRole('region', { name: 'Activity timeline' })).toBeInTheDocument()
  })
})
