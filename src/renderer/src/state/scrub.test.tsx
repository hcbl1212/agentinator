// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { ScrubProvider, useScrub } from './scrub'

function stub(count = 0): { bridge: AgentinatorBridge; emit: (event: StoredEvent) => void } {
  let appended: (event: StoredEvent) => void = () => undefined
  return {
    emit: (event) => appended(event),
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(count)),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
    } as unknown as AgentinatorBridge,
  }
}

afterEach(() => {
  delete window.agentinator
})

describe('ScrubProvider', () => {
  it('seeds max from the log count and grows it on live appends; setSeq pins/live', async () => {
    const s = stub(5)
    window.agentinator = s.bridge
    const { result } = renderHook(() => useScrub(), { wrapper: ScrubProvider })

    await waitFor(() => {
      expect(result.current.max).toBe(5)
    })
    expect(result.current.seq).toBeNull() // live by default

    act(() => {
      s.emit({ seq: 9, ts: 't', type: 'agent.text', payload: { sessionId: 's', text: 'hi' } })
    })
    expect(result.current.max).toBe(9)

    act(() => result.current.setSeq(3))
    expect(result.current.seq).toBe(3)
    act(() => result.current.setSeq(null))
    expect(result.current.seq).toBeNull()
  })

  it('stays at max 0 without a bridge', () => {
    const { result } = renderHook(() => useScrub(), { wrapper: ScrubProvider })
    expect(result.current.max).toBe(0)
    expect(result.current.seq).toBeNull()
  })

  it('ignores the count that resolves after unmount', async () => {
    window.agentinator = stub(5).bridge
    const { unmount } = renderHook(() => useScrub(), { wrapper: ScrubProvider })
    unmount()
    // The count promise resolves after unmount → the cancelled guard skips it.
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('throws when used outside a provider', () => {
    expect(() => renderHook(() => useScrub())).toThrow('within a ScrubProvider')
  })
})
