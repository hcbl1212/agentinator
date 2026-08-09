// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { CapacityBanner } from './CapacityBanner'

interface Stub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  switchToApiKey: ReturnType<typeof vi.fn>
  has: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
}

function stubBridge(hasKey = false): Stub {
  let appended: ((event: StoredEvent) => void) | undefined
  const switchToApiKey = vi.fn(() => Promise.resolve())
  const has = vi.fn(() => Promise.resolve(hasKey))
  const set = vi.fn(() => Promise.resolve())
  return {
    switchToApiKey,
    has,
    set,
    emit: (event) => appended?.(event),
    bridge: {
      events: {
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
      agent: { switchToApiKey },
      credentials: { has, set },
    } as unknown as AgentinatorBridge,
  }
}

function limit(overrides: Partial<EventPayloads['account.limit']> = {}): StoredEvent {
  const payload: EventPayloads['account.limit'] = {
    sessionId: 's',
    providerId: 'claude',
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
    expect(banner).toHaveTextContent('Overage available — new work continues on credits.')
    expect(screen.getByRole('link', { name: 'Manage plan' })).toHaveAttribute(
      'href',
      'https://claude.ai/settings/billing',
    )

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status', { name: 'Capacity limit' })).not.toBeInTheDocument()
  })

  it('surfaces overage state — in use, then none on a rejection, then none on a warning', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<CapacityBanner />)

    act(() => {
      stub.emit(limit({ overageInUse: true }))
    })
    expect(screen.getByRole('status')).toHaveTextContent('Using overage credits.')

    act(() => {
      stub.emit(limit({ status: 'rejected', overageAvailable: false, overageInUse: false }))
    })
    expect(screen.getByRole('status')).toHaveTextContent('Enable overage, or wait for the reset.')

    act(() => {
      stub.emit(limit({ status: 'warning', overageAvailable: false, overageInUse: false }))
    })
    const banner = screen.getByRole('status')
    expect(banner).not.toHaveTextContent('Overage')
    expect(banner).not.toHaveTextContent('Enable overage')
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

  it('switches immediately when a key is already stored', async () => {
    const stub = stubBridge(true) // has a stored key
    window.agentinator = stub.bridge

    render(<CapacityBanner />)
    act(() => {
      stub.emit(limit())
    })

    await userEvent.click(screen.getByRole('button', { name: 'Continue on API key' }))

    expect(stub.has).toHaveBeenCalledWith('claude')
    expect(stub.switchToApiKey).toHaveBeenCalledWith('s')
    expect(screen.queryByRole('status')).not.toBeInTheDocument() // banner cleared
  })

  it('prompts for a key inline, saves it to the keychain, and switches (Enter)', async () => {
    const stub = stubBridge(false) // no stored key
    window.agentinator = stub.bridge

    render(<CapacityBanner />)
    act(() => {
      stub.emit(limit())
    })

    await userEvent.click(screen.getByRole('button', { name: 'Continue on API key' }))
    await userEvent.type(screen.getByLabelText('API key'), 'sk-live-123{Enter}')

    expect(stub.set).toHaveBeenCalledWith('claude', 'sk-live-123', true)
    expect(stub.switchToApiKey).toHaveBeenCalledWith('s')
  })

  it('ignores Continue/Save when the provider, key, or bridge is missing', async () => {
    const stub = stubBridge(false)
    window.agentinator = stub.bridge

    render(<CapacityBanner />)
    // 1. No provider → a no-op (the vendor is unknown).
    act(() => {
      stub.emit(limit({ providerId: undefined }))
    })
    await userEvent.click(screen.getByRole('button', { name: 'Continue on API key' }))
    expect(stub.has).not.toHaveBeenCalled()

    // 2. Provider present, no stored key → the field opens; an empty save is a no-op.
    act(() => {
      stub.emit(limit({ status: 'warning' })) // change status to re-surface
      stub.emit(limit()) // rejected again, with a provider
    })
    await userEvent.click(screen.getByRole('button', { name: 'Continue on API key' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save & switch' }))
    expect(stub.set).not.toHaveBeenCalled()

    // 3. Bridge vanished → Save can neither switch nor crash.
    await userEvent.type(screen.getByLabelText('API key'), 'sk')
    delete window.agentinator
    await userEvent.click(screen.getByRole('button', { name: 'Save & switch' }))
    expect(stub.switchToApiKey).not.toHaveBeenCalled()
  })
})
