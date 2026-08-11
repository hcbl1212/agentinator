import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { SyncGitRunner } from './git'
import { NodeWorktrees, noopWorktrees, worktreeBranch } from './worktrees'

describe('worktreeBranch', () => {
  it('namespaces the branch under agentinator/', () => {
    expect(worktreeBranch('session_abc')).toBe('agentinator/session_abc')
  })
})

describe('noopWorktrees', () => {
  it('isolates nothing — create null, restore false, remove a no-op', () => {
    expect(noopWorktrees.create('session_1', '/repo')).toBeNull()
    expect(noopWorktrees.restore({ repoRoot: '/repo', path: '/wt', branch: 'b' })).toBe(false)
    expect(() =>
      noopWorktrees.remove({ repoRoot: '/repo', path: '/wt', branch: 'b' }),
    ).not.toThrow()
  })
})

describe('NodeWorktrees.create', () => {
  it('adds a worktree on a fresh branch off HEAD and returns its info', () => {
    const git: SyncGitRunner = vi.fn(() => '')
    const wt = new NodeWorktrees('/base', git)

    const info = wt.create('session_1', '/repo')

    expect(info).toEqual({
      repoRoot: '/repo',
      path: join('/base', 'session_1'),
      branch: 'agentinator/session_1',
    })
    expect(git).toHaveBeenCalledWith(['rev-parse', '--verify', 'HEAD'], '/repo')
    expect(git).toHaveBeenCalledWith(
      ['worktree', 'add', '-b', 'agentinator/session_1', join('/base', 'session_1'), 'HEAD'],
      '/repo',
    )
  })

  it('returns null when the repo has no commit / is not a git repo', () => {
    const git: SyncGitRunner = vi.fn((args: string[]) => {
      if (args[0] === 'rev-parse') {
        throw new Error('fatal: not a git repository')
      }
      return ''
    })

    expect(new NodeWorktrees('/base', git).create('session_1', '/nope')).toBeNull()
  })

  it('returns null when the worktree add itself fails', () => {
    const git: SyncGitRunner = vi.fn((args: string[]) => {
      if (args[0] === 'worktree') {
        throw new Error('already exists')
      }
      return ''
    })

    expect(new NodeWorktrees('/base', git).create('session_1', '/repo')).toBeNull()
  })
})

describe('NodeWorktrees.restore', () => {
  const info = {
    repoRoot: '/repo',
    path: join('/base', 'session_1'),
    branch: 'agentinator/session_1',
  }

  it('is a no-op when the worktree directory still exists', () => {
    const git: SyncGitRunner = vi.fn(() => '')
    const wt = new NodeWorktrees('/base', git, () => true)

    expect(wt.restore(info)).toBe(true)
    expect(git).not.toHaveBeenCalled()
  })

  it('re-attaches a worktree to the existing branch when the directory is gone', () => {
    const git: SyncGitRunner = vi.fn(() => '')
    const wt = new NodeWorktrees('/base', git, () => false)

    expect(wt.restore(info)).toBe(true)
    expect(git).toHaveBeenCalledWith(['worktree', 'add', info.path, info.branch], '/repo')
  })

  it('returns false when the worktree cannot be recreated', () => {
    const git: SyncGitRunner = vi.fn(() => {
      throw new Error('branch gone')
    })
    const wt = new NodeWorktrees('/base', git, () => false)

    expect(wt.restore(info)).toBe(false)
  })
})

describe('NodeWorktrees.remove', () => {
  const info = {
    repoRoot: '/repo',
    path: join('/base', 'session_1'),
    branch: 'agentinator/session_1',
  }

  it('removes the worktree and deletes its branch', () => {
    const git: SyncGitRunner = vi.fn(() => '')
    new NodeWorktrees('/base', git).remove(info)

    expect(git).toHaveBeenCalledWith(['worktree', 'remove', '--force', info.path], '/repo')
    expect(git).toHaveBeenCalledWith(['branch', '-D', info.branch], '/repo')
  })

  it('swallows errors from both cleanup steps', () => {
    const git: SyncGitRunner = vi.fn(() => {
      throw new Error('nothing to remove')
    })

    expect(() => new NodeWorktrees('/base', git).remove(info)).not.toThrow()
  })
})
