// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from './App'

describe('App', () => {
  it('renders the cockpit shell with all panes', () => {
    render(<App />)

    expect(screen.getByText('Agentinator')).toBeInTheDocument()
    expect(screen.getByText('no workspace open')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Agents' })).toBeInTheDocument()
    // The unified conversation ∪ timeline stream, with its composer…
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Activity timeline' })).toBeInTheDocument()
    expect(screen.getByLabelText('Composer')).toBeInTheDocument()
    // …and the Diff/Preview inspector.
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo', { name: 'Status bar' })).toBeInTheDocument()
  })

  it('shows the empty states that orient a first-time user', () => {
    render(<App />)

    // No agent selected → the stream and diff prompt you to pick one…
    expect(screen.getByText(/Select an agent, or start a task below/)).toBeInTheDocument()
    expect(screen.getByText(/Select an agent to see its changes/)).toBeInTheDocument()
    // …and the composer is ready to launch one.
    expect(screen.getByText(/Open a workspace to talk to an agent/)).toBeInTheDocument()
  })

  it('shows a zeroed cost readout and version in the status bar', () => {
    render(<App />)

    expect(screen.getByText('$0.0000')).toBeInTheDocument()
    expect(screen.getByText('budget —')).toBeInTheDocument()
    expect(screen.getByText('v0.1.0')).toBeInTheDocument()
  })
})
