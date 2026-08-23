// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import { ScrubProvider } from '../state/scrub'
import { Scrubber } from './Scrubber'

function renderScrubber(count?: number): void {
  if (count !== undefined) {
    window.agentinator = {
      events: {
        count: vi.fn(() => Promise.resolve(count)),
        onAppended: vi.fn(() => () => undefined),
      },
    } as unknown as AgentinatorBridge
  }
  render(
    <ScrubProvider>
      <Scrubber />
    </ScrubProvider>,
  )
}

afterEach(() => {
  delete window.agentinator
})

describe('Scrubber', () => {
  it('hides while the log has nothing to scrub', () => {
    renderScrubber() // no bridge → max stays 0
    expect(screen.queryByRole('group', { name: 'Timeline scrubber' })).not.toBeInTheDocument()
  })

  it('scrubs to a point and returns to live', async () => {
    renderScrubber(5)

    const slider = await screen.findByRole('slider', { name: 'Scrub timeline' })
    // Live by default: position reads "live", the Live button is disabled.
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Live' })).toBeDisabled()

    fireEvent.change(slider, { target: { value: '3' } })
    await waitFor(() => {
      expect(screen.getByText('#3 / 5')).toBeInTheDocument()
    })
    const live = screen.getByRole('button', { name: 'Live' })
    expect(live).toBeEnabled()

    fireEvent.click(live)
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Live' })).toBeDisabled()
  })
})
