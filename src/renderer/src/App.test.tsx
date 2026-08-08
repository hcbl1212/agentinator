// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from './App'

describe('App', () => {
  it('renders the cockpit shell with all panes', () => {
    render(<App />)

    expect(screen.getByText('Agentinator')).toBeInTheDocument()
    expect(screen.getByText('no workspace open')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Agent roster' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Activity timeline' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'App preview' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo', { name: 'Status bar' })).toBeInTheDocument()
  })

  it('shows the empty states that orient a first-time user', () => {
    render(<App />)

    expect(screen.getByText(/No agents yet/)).toBeInTheDocument()
    expect(screen.getByText(/Agent activity will stream here/)).toBeInTheDocument()
    expect(screen.getByText(/target app renders here/)).toBeInTheDocument()
  })

  it('shows a zeroed cost readout and version in the status bar', () => {
    render(<App />)

    expect(screen.getByText('$0.0000')).toBeInTheDocument()
    expect(screen.getByText('budget —')).toBeInTheDocument()
    expect(screen.getByText('v0.1.0')).toBeInTheDocument()
  })
})
