import { describe, expect, it, vi } from 'vitest'

import type { SyncGitRunner } from './git'
import { NodeCheckpoints } from './checkpoints'

describe('NodeCheckpoints.create', () => {
  it('snapshots the worktree to a dangling commit and leaves it staged as before', () => {
    const git: SyncGitRunner = vi.fn((args: string[]) => {
      if (args[0] === 'write-tree') return 'tree123\n'
      if (args[0] === 'commit-tree') return 'commitABC\n'
      return ''
    })

    const sha = new NodeCheckpoints(git).create('/wt', 'first try')

    expect(sha).toBe('commitABC')
    expect(git).toHaveBeenCalledWith(['add', '-A'], '/wt')
    expect(git).toHaveBeenCalledWith(['write-tree'], '/wt')
    expect(git).toHaveBeenCalledWith(
      ['commit-tree', 'tree123', '-p', 'HEAD', '-m', 'checkpoint: first try'],
      '/wt',
    )
    expect(git).toHaveBeenCalledWith(['reset', '-q', 'HEAD'], '/wt')
  })

  it('returns null when git fails', () => {
    const git: SyncGitRunner = vi.fn(() => {
      throw new Error('not a worktree')
    })
    expect(new NodeCheckpoints(git).create('/nope', 'x')).toBeNull()
  })
})

describe('NodeCheckpoints.restore', () => {
  it('resets the worktree to the snapshot, cleans, and unstages', () => {
    const git: SyncGitRunner = vi.fn(() => '')

    expect(new NodeCheckpoints(git).restore('/wt', 'commitABC')).toBe(true)
    expect(git).toHaveBeenCalledWith(['read-tree', '-u', '--reset', 'commitABC'], '/wt')
    expect(git).toHaveBeenCalledWith(['clean', '-fdq'], '/wt')
    expect(git).toHaveBeenCalledWith(['reset', '-q', 'HEAD'], '/wt')
  })

  it('returns false when git fails', () => {
    const git: SyncGitRunner = vi.fn(() => {
      throw new Error('bad object')
    })
    expect(new NodeCheckpoints(git).restore('/wt', 'gone')).toBe(false)
  })
})
