import { execFile, execFileSync } from 'node:child_process'

/** Runs a git command in a working dir and resolves its stdout. Injected so the
 * diff logic stays a pure, subprocess-free unit under test. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>

/** A synchronous git command, returning stdout and throwing on any nonzero
 * exit. Injected like GitRunner so the worktree lifecycle is testable without a
 * subprocess. Sync because worktree setup runs inline at session start — the
 * agent's cwd must exist before it begins — and these commands are fast. */
export type SyncGitRunner = (args: string[], cwd: string) => string

/** The real runner. `git diff --no-index` exits 1 when files differ — that's a
 * normal "there are changes" result for us, not a failure; anything else (e.g.
 * 128 for "not a git repo") rejects. */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null && (error as { code?: number }).code !== 1) {
        reject(new Error(error.message))
        return
      }
      resolve(stdout)
    })
  })

/** The real sync runner for worktree commands. Throws on nonzero exit (no
 * exit-1 carve-out — worktree/branch commands don't use that convention). */
export const runGitSync: SyncGitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })
