// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { Inspector } from './Inspector'

afterEach(() => {
  delete window.agentinator
})

describe('Inspector', () => {
  it('shows the diff tab by default', () => {
    render(<Inspector />)

    expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'App preview' })).not.toBeInTheDocument()
  })

  it('switches to the preview tab and back', async () => {
    const user = userEvent.setup()
    render(<Inspector />)

    await user.click(screen.getByRole('tab', { name: 'Preview' }))

    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'App preview' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Diff' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Diff' }))
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument()
  })
})
