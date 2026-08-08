// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import { Roster } from './Roster'

function stubBridge(): AgentinatorBridge {
  return {
    events: {
      count: vi.fn(() => Promise.resolve(0)),
      list: vi.fn(() => Promise.resolve([])),
      tail: vi.fn(() => Promise.resolve([])),
      onAppended: vi.fn(() => () => undefined),
    },
    agent: {
      startDemo: vi.fn(() => Promise.resolve('session_1')),
      cancel: vi.fn(() => Promise.resolve()),
    },
  }
}

afterEach(() => {
  delete window.agentinator
})

describe('Roster', () => {
  it('hides the demo button without a bridge (plain browser/test)', () => {
    render(<Roster />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('starts the demo session and confirms dispatch', async () => {
    const bridge = stubBridge()
    window.agentinator = bridge
    const user = userEvent.setup()

    render(<Roster />)
    await user.click(screen.getByRole('button', { name: /Run demo agent/ }))

    expect(bridge.agent.startDemo).toHaveBeenCalledOnce()
    expect(screen.getByText(/Demo dispatched/)).toBeInTheDocument()
  })
})
