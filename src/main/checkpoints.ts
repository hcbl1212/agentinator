import type { SyncGitRunner } from './git'

/**
 * Snapshot and rewind an isolated agent's worktree. A checkpoint is a *dangling*
 * git commit (not on any branch, HEAD untouched) capturing the whole dirty tree
 * — tracked edits and new files alike — so the agent can be rewound to it after
 * going down a bad path, instead of cancelled and restarted. Injected over a
 * sync git runner so the lifecycle is testable without a real repo.
 */
export interface Checkpoints {
  /** Snapshot the worktree to a commit, returning its sha — or null if git
   * fails (e.g. the dir isn't a worktree). The working tree is left untouched. */
  create(worktreePath: string, label: string): string | null
  /** Rewind the worktree to a checkpoint commit (restoring its files, removing
   * anything created since). Returns whether it succeeded. */
  restore(worktreePath: string, sha: string): boolean
}

export class NodeCheckpoints implements Checkpoints {
  #git: SyncGitRunner

  constructor(git: SyncGitRunner) {
    this.#git = git
  }

  create(worktreePath: string, label: string): string | null {
    try {
      // Stage everything (tracked + untracked + deletions), write it as a tree,
      // and commit that tree without moving HEAD/the branch; then unstage so the
      // working tree and index look exactly as they did.
      this.#git(['add', '-A'], worktreePath)
      const tree = this.#git(['write-tree'], worktreePath).trim()
      const sha = this.#git(
        ['commit-tree', tree, '-p', 'HEAD', '-m', `checkpoint: ${label}`],
        worktreePath,
      ).trim()
      this.#git(['reset', '-q', 'HEAD'], worktreePath)
      return sha
    } catch {
      return null
    }
  }

  restore(worktreePath: string, sha: string): boolean {
    try {
      // Reset the working tree + index to the snapshot's tree, drop anything
      // created since (untracked), then unstage so it reads as uncommitted
      // changes vs HEAD again.
      this.#git(['read-tree', '-u', '--reset', sha], worktreePath)
      this.#git(['clean', '-fdq'], worktreePath)
      this.#git(['reset', '-q', 'HEAD'], worktreePath)
      return true
    } catch {
      return false
    }
  }
}
