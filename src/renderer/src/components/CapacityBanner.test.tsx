// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import type { AccountLimit } from '../../../shared/usage'
import { CapacityBanner } from './CapacityBanner'

function stubBridge(): { bridge: AgentinatorBridge; emit: (event: StoredEvent) => void } {
  let appended: ((event: StoredEvent) => void) | undefined
  return {
    emit: (event) => appended?.(event),
    bridge: {
      events: {
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
    } as unknown as AgentinatorBridge,
  }
}

function limit(overrides: Partial<AccountLimit> = {}): StoredEvent {
  const payload: EventPayloads['account.limit'] = {
    sessionId: 's',
    status: 'rejected',
    window: 'five_hour',
    resetsAtMs: 1_700_000_000_000,
    utilization: 100,
    overageAvailable: true,
    overageInUse: false,
    ...overrides,
  }
  return { seq: 1, ts: 't', type: 'account.limit', payload }
}

function other(type: EventType): StoredEvent {
  return { seq: 1, ts: 't', type, payload: { sessionId: 's' } }
}

afterEach(() => {
  delete window.agentinator
})

describe('CapacityBanner', () => {
  it('renders nothing without a bridge', () => {
    const { container } = render(<CapacityBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a rejection with window + reset, and Dismiss hides it', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<CapacityBanner />)
    act(() => {
      stub.emit(limit())
    })

    const banner = screen.getByRole('status', { name: 'Capacity limit' })
    expect(banner).toHaveTextContent(/Reached your session \(5-hour\) limit/)
    expect(banner).toHaveTextContent(/resets/)

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status', { name: 'Capacity limit' })).not.toBeInTheDocument()
  })

  it('shows a warning for an unknown window with no reset, and ignores non-limit events', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<CapacityBanner />)
    act(() => {
      stub.emit(other('agent.text')) // ignored
      stub.emit(limit({ status: 'warning', window: 'weekly_scoped', resetsAtMs: null }))
    })

    const banner = screen.getByRole('status', { name: 'Capacity limit' })
    expect(banner).toHaveTextContent('Approaching your weekly_scoped limit.')
    expect(banner).not.toHaveTextContent(/resets/)
  })

  it('labels a window-less limit as "plan" and hides once the limit clears', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<CapacityBanner />)
    act(() => {
      stub.emit(limit({ window: null }))
    })
    expect(screen.getByRole('status')).toHaveTextContent('Reached your plan limit')

    act(() => {
      stub.emit(limit({ status: 'ok' }))
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps a dismiss across identical signals but re-surfaces on a status change', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<CapacityBanner />)
    act(() => {
      stub.emit(limit()) // rejected
    })
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    act(() => {
      stub.emit(limit()) // same status → stays dismissed
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => {
      stub.emit(limit({ status: 'warning' })) // status change → back
    })
    expect(screen.getByRole('status')).toHaveTextContent(/Approaching/)
  })
})
