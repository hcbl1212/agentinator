// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import { StatusBar } from './StatusBar'

function stubBridge(count: Promise<number>): AgentinatorBridge {
  return {
    events: {
      count: vi.fn(() => count),
      list: vi.fn(() => Promise.resolve([])),
    },
  }
}

afterEach(() => {
  delete window.agentinator
})

describe('StatusBar', () => {
  it('shows a placeholder when no bridge is available (plain browser/test)', () => {
    render(<StatusBar />)

    expect(screen.getByText('log —')).toBeInTheDocument()
  })

  it('shows the event-log count fetched over the bridge', async () => {
    window.agentinator = stubBridge(Promise.resolve(3))

    render(<StatusBar />)

    await waitFor(() => {
      expect(screen.getByText('log 3 events')).toBeInTheDocument()
    })
  })

  it('ignores a count that resolves after unmount', async () => {
    let resolveCount: (n: number) => void = () => undefined
    window.agentinator = stubBridge(
      new Promise<number>((resolve) => {
        resolveCount = resolve
      }),
    )

    const { unmount } = render(<StatusBar />)
    unmount()
    resolveCount(9)
    await Promise.resolve()

    expect(screen.queryByText('log 9 events')).not.toBeInTheDocument()
  })
})
