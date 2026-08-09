// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Preview } from './Preview'

describe('Preview', () => {
  it('prompts to pick an agent when none is selected', () => {
    render(<Preview sessionId={null} />)

    expect(screen.getByText(/Select an agent to preview its app/)).toBeInTheDocument()
  })

  it('shows the app-preview placeholder for a selected agent', () => {
    render(<Preview sessionId="s" />)

    expect(screen.getByText(/target app renders here/)).toBeInTheDocument()
  })
})
