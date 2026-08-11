import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { SyncGitRunner } from './git'

/** Where a session's isolated checkout lives, and the branch it's on. Persisted
 * on session.started so resume can reuse it and dismiss can tear it down. */
export interface WorktreeInfo {
  repoRoot: string
  path: string
  branch: string
}

/**
 * Per-session git worktree isolation: each agent gets its own checkout on its
 * own branch, so two agents editing the same repo never share (and corrupt) a
 * working tree. Injected into the SessionManager so the lifecycle is testable
 * without a real repo.
 */
export interface Worktrees {
  /** Create an isolated worktree + branch for a session off `repoRoot`. Returns
   * null when `repoRoot` isn't a git repo with a commit, or creation fails —
   * the caller then runs the agent directly in `repoRoot` (no isolation). */
  create(sessionId: string, repoRoot: string): WorktreeInfo | null
  /** Make sure a previously-created worktree exists on disk (recreating it from
   * its branch if the directory was cleaned), for resume. Returns true when the
   * worktree is usable, false when it can't be restored (caller falls back to
   * the repo root). */
  restore(info: WorktreeInfo): boolean
  /** Remove a session's worktree and delete its branch (best-effort). */
  remove(info: WorktreeInfo): void
}

/** The default when no isolation is wired: every session runs in its cwd. */
export const noopWorktrees: Worktrees = {
  create: () => null,
  restore: () => false,
  remove: () => undefined,
}

/** The branch a session's worktree lives on. Session ids are already safe
 * ref characters (`session_<uuid>`), so no sanitizing is needed. */
export function worktreeBranch(sessionId: string): string {
  return `agentinator/${sessionId}`
}

/**
 * Real worktree isolation over a sync git runner. Worktrees are created under a
 * managed base directory (kept out of the repo tree), one per session id.
 */
export class NodeWorktrees implements Worktrees {
  #git: SyncGitRunner
  #baseDir: string
  #exists: (path: string) => boolean

  constructor(baseDir: string, git: SyncGitRunner, exists: (path: string) => boolean = existsSync) {
    this.#baseDir = baseDir
    this.#git = git
    this.#exists = exists
  }

  create(sessionId: string, repoRoot: string): WorktreeInfo | null {
    const path = join(this.#baseDir, sessionId)
    const branch = worktreeBranch(sessionId)
    try {
      // Verify there's a commit to branch from — this also fails fast when
      // repoRoot isn't a git repo, so a non-repo cwd degrades to no isolation.
      this.#git(['rev-parse', '--verify', 'HEAD'], repoRoot)
      this.#git(['worktree', 'add', '-b', branch, path, 'HEAD'], repoRoot)
      return { repoRoot, path, branch }
    } catch {
      return null
    }
  }

  restore(info: WorktreeInfo): boolean {
    if (this.#exists(info.path)) {
      return true
    }
    try {
      // The branch still exists in the repo; re-attach a worktree to it.
      this.#git(['worktree', 'add', info.path, info.branch], info.repoRoot)
      return true
    } catch {
      return false
    }
  }

  remove(info: WorktreeInfo): void {
    try {
      this.#git(['worktree', 'remove', '--force', info.path], info.repoRoot)
    } catch {
      // Already gone, or the repo moved — nothing to clean.
    }
    try {
      this.#git(['branch', '-D', info.branch], info.repoRoot)
    } catch {
      // Branch already deleted or never created.
    }
  }
}
