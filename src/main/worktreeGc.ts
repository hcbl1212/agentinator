import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { Worktrees, WorktreeInfo } from './worktrees'

/** Best-effort recursive size of a directory in bytes. Skips anything it can't
 * read (a vanished file, a permission error) rather than throwing — a size
 * readout must never crash the cleanup UI. */
export function dirSizeBytes(path: string): number {
  let names: string[]
  try {
    names = readdirSync(path)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    const full = join(path, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue // vanished, or a dangling symlink — skip it
    }
    total += stat.isDirectory() ? dirSizeBytes(full) : stat.size
  }
  return total
}

/** What the janitor needs, injected so its logic is testable without a real
 * repo or filesystem. */
export interface WorktreeJanitorDeps {
  /** Finished sessions' persisted worktrees (from the event log). */
  endedWorktrees: () => { sessionId: string; worktree: WorktreeInfo }[]
  /** Whether a worktree directory is still on disk. */
  exists: (path: string) => boolean
  /** Size of a worktree directory in bytes. */
  sizeOf: (path: string) => number
  /** Removes a worktree + its branch. */
  worktrees: Pick<Worktrees, 'remove'>
}

/**
 * On-demand cleanup of finished agents' worktrees: the ones whose session has
 * ended but whose checkout still sits on disk (an agent that completed or
 * failed without being dismissed). Nothing here runs automatically — it's
 * driven entirely by the user pressing "Clean up".
 */
export class WorktreeJanitor {
  #deps: WorktreeJanitorDeps

  constructor(deps: WorktreeJanitorDeps) {
    this.#deps = deps
  }

  #reclaimable(): WorktreeInfo[] {
    // A pipeline's stages share one worktree, so several ended sessions can
    // report the same path — dedupe by path so it's counted and freed once.
    const seen = new Set<string>()
    return this.#deps
      .endedWorktrees()
      .map((ended) => ended.worktree)
      .filter((info) => {
        if (seen.has(info.path) || !this.#deps.exists(info.path)) {
          return false
        }
        seen.add(info.path)
        return true
      })
  }

  /** How many finished worktrees are still on disk, and their total size. */
  summary(): { count: number; bytes: number } {
    const infos = this.#reclaimable()
    const bytes = infos.reduce((sum, info) => sum + this.#deps.sizeOf(info.path), 0)
    return { count: infos.length, bytes }
  }

  /** Remove every finished worktree (and its branch); returns how many were
   * removed and roughly how many bytes that freed. */
  cleanup(): { count: number; bytes: number } {
    const infos = this.#reclaimable()
    let bytes = 0
    for (const info of infos) {
      bytes += this.#deps.sizeOf(info.path)
      this.#deps.worktrees.remove(info)
    }
    return { count: infos.length, bytes }
  }
}
