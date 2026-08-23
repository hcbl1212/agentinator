// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { Skill } from '../../../shared/skills'
import { SkillsProvider, useSkills } from './skills'

function stub(initial: Skill[] = []): {
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
    bridge: { skills: { list, save, remove } } as unknown as AgentinatorBridge,
  }
}

afterEach(() => {
  delete window.agentinator
})

describe('SkillsProvider', () => {
  it('loads skills on mount and re-reads after save and remove', async () => {
    const s = stub([{ id: 's1', name: 'Commits', description: 'd', body: 'b' }])
    window.agentinator = s.bridge
    const { result } = renderHook(() => useSkills(), { wrapper: SkillsProvider })

    await waitFor(() => {
      expect(result.current.skills).toHaveLength(1)
    })

    await act(async () => {
      await result.current.save({ id: 's2', name: 'Tests', description: 'd', body: 'body' })
    })
    expect(s.save).toHaveBeenCalledWith({ id: 's2', name: 'Tests', description: 'd', body: 'body' })

    await act(async () => {
      await result.current.remove('s1')
    })
    expect(s.remove).toHaveBeenCalledWith('s1')
    expect(s.list).toHaveBeenCalledTimes(3)
  })

  it('is a no-op without a bridge', async () => {
    const { result } = renderHook(() => useSkills(), { wrapper: SkillsProvider })

    await act(async () => {
      await result.current.save({ id: 's1', name: 'x', description: '', body: '' })
      await result.current.remove('s1')
    })

    expect(result.current.skills).toEqual([])
  })

  it('throws when used outside a provider', () => {
    expect(() => renderHook(() => useSkills())).toThrow('within a SkillsProvider')
  })
})
