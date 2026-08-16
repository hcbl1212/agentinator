// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentType } from '../../../shared/agentTypes'
import type { AgentinatorBridge } from '../../../shared/bridge'
import { AgentTypesProvider, useAgentTypes } from './agentTypes'

function stub(initial: AgentType[] = []): {
  bridge: AgentinatorBridge
  list: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const list = vi.fn(() => Promise.resolve(initial))
  const save = vi.fn(() => Promise.resolve())
  const remove = vi.fn(() => Promise.resolve())
  return {
    list,
    save,
    remove,
    bridge: { agentTypes: { list, save, remove } } as unknown as AgentinatorBridge,
  }
}

afterEach(() => {
  delete window.agentinator
})

describe('AgentTypesProvider', () => {
  it('loads types on mount and re-reads after save and remove', async () => {
    const s = stub([{ id: 'a', name: 'Reviewer', instructions: 'x' }])
    window.agentinator = s.bridge
    const { result } = renderHook(() => useAgentTypes(), { wrapper: AgentTypesProvider })

    await waitFor(() => {
      expect(result.current.types).toHaveLength(1)
    })

    await act(async () => {
      await result.current.save({ id: 'b', name: 'Tester', instructions: 'y' })
    })
    expect(s.save).toHaveBeenCalledWith({ id: 'b', name: 'Tester', instructions: 'y' })

    await act(async () => {
      await result.current.remove('a')
    })
    expect(s.remove).toHaveBeenCalledWith('a')
    // mount + after-save + after-remove.
    expect(s.list).toHaveBeenCalledTimes(3)
  })

  it('is a no-op without a bridge', async () => {
    const { result } = renderHook(() => useAgentTypes(), { wrapper: AgentTypesProvider })

    await act(async () => {
      await result.current.save({ id: 'a', name: 'x', instructions: '' })
      await result.current.remove('a')
    })

    expect(result.current.types).toEqual([])
  })

  it('throws when used outside a provider', () => {
    expect(() => renderHook(() => useAgentTypes())).toThrow('within an AgentTypesProvider')
  })
})
