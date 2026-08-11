import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { WorktreeInfo } from './worktrees'
import { dirSizeBytes, WorktreeJanitor } from './worktreeGc'

describe('dirSizeBytes', () => {
  it('sums file sizes recursively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-size-'))
    writeFileSync(join(dir, 'a.txt'), 'hello') // 5
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'b.txt'), 'world!') // 6

    expect(dirSizeBytes(dir)).toBe(11)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 0 for a directory that does not exist', () => {
    expect(dirSizeBytes(join(tmpdir(), 'agentinator-nope-does-not-exist'))).toBe(0)
  })

  it('skips entries that vanish or cannot be stat-ed (dangling symlink)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-size-'))
    writeFileSync(join(dir, 'real.txt'), 'abc') // 3
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling')) // stat throws, skipped

    expect(dirSizeBytes(dir)).toBe(3)
    rmSync(dir, { recursive: true, force: true })
  })
})

function info(id: string, path: string): WorktreeInfo {
  return { repoRoot: '/repo', path, branch: `agentinator/${id}` }
}

describe('WorktreeJanitor', () => {
  it('summarizes only finished worktrees still on disk', () => {
    const onDisk = info('s1', '/wt/s1')
    const gone = info('s2', '/wt/s2') // dismissed already — dir removed
    const janitor = new WorktreeJanitor({
      endedWorktrees: () => [
        { sessionId: 's1', worktree: onDisk },
        { sessionId: 's2', worktree: gone },
      ],
      exists: (path) => path === '/wt/s1',
      sizeOf: () => 100,
      worktrees: { remove: vi.fn() },
    })

    expect(janitor.summary()).toEqual({ count: 1, bytes: 100 })
  })

  it('removes every reclaimable worktree and reports the bytes freed', () => {
    const a = info('s1', '/wt/s1')
    const b = info('s2', '/wt/s2')
    const remove = vi.fn()
    const janitor = new WorktreeJanitor({
      endedWorktrees: () => [
        { sessionId: 's1', worktree: a },
        { sessionId: 's2', worktree: b },
      ],
      exists: () => true,
      sizeOf: () => 50,
      worktrees: { remove },
    })

    expect(janitor.cleanup()).toEqual({ count: 2, bytes: 100 })
    expect(remove).toHaveBeenCalledWith(a)
    expect(remove).toHaveBeenCalledWith(b)
  })

  it('cleans up nothing when there are no finished worktrees on disk', () => {
    const remove = vi.fn()
    const janitor = new WorktreeJanitor({
      endedWorktrees: () => [],
      exists: () => false,
      sizeOf: () => 0,
      worktrees: { remove },
    })

    expect(janitor.cleanup()).toEqual({ count: 0, bytes: 0 })
    expect(remove).not.toHaveBeenCalled()
  })
})
