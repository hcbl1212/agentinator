// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Stream } from './Stream'

afterEach(() => {
  delete window.agentinator
})

describe('Stream', () => {
  it('unifies the timeline and the composer in one conversation surface', () => {
    render(<Stream />)

    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument()
    // The full timeline is the stream…
    expect(screen.getByRole('region', { name: 'Activity timeline' })).toBeInTheDocument()
    expect(screen.getByText(/Agent activity will stream here/)).toBeInTheDocument()
    // …and the composer docks at its foot.
    expect(screen.getByLabelText('Composer')).toBeInTheDocument()
    expect(screen.getByText(/Open a workspace to talk to an agent/)).toBeInTheDocument()
  })
})
