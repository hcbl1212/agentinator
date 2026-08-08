// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { AgentRail } from './AgentRail'

function stubBridge(): { bridge: AgentinatorBridge; emit: (event: StoredEvent) => void } {
  let appended: ((event: StoredEvent) => void) | undefined
  return {
    emit: (event) => appended?.(event),
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
    } as unknown as AgentinatorBridge,
  }
}

function sessionEvent(type: 'session.started' | 'session.ended'): StoredEvent {
  return { seq: 1, ts: 't', type, payload: { sessionId: 's' } } as StoredEvent
}

afterEach(() => {
  delete window.agentinator
})

describe('AgentRail', () => {
  it('shows an empty rail with no bridge', () => {
    render(<AgentRail />)

    expect(screen.getByLabelText('No active agents')).toBeInTheDocument()
  })

  it('counts running agents up on start and down on end, never below zero', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<AgentRail />)
    expect(screen.getByLabelText('No active agents')).toBeInTheDocument()

    act(() => {
      stub.emit(sessionEvent('session.started'))
      stub.emit(sessionEvent('session.started'))
    })
    expect(screen.getByLabelText('2 active')).toBeInTheDocument()

    act(() => {
      stub.emit(sessionEvent('session.ended'))
    })
    expect(screen.getByLabelText('1 active')).toBeInTheDocument()

    // Two more ends than starts must floor at zero, not go negative.
    act(() => {
      stub.emit(sessionEvent('session.ended'))
      stub.emit(sessionEvent('session.ended'))
    })
    expect(screen.getByLabelText('No active agents')).toBeInTheDocument()
  })

  it('ignores unrelated events', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    render(<AgentRail />)
    act(() => {
      stub.emit({ seq: 2, ts: 't', type: 'agent.text', payload: {} } as StoredEvent)
    })

    expect(screen.getByLabelText('No active agents')).toBeInTheDocument()
  })
})
