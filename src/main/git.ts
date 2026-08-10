import { execFile } from 'node:child_process'

/** Runs a git command in a working dir and resolves its stdout. Injected so the
 * diff logic stays a pure, subprocess-free unit under test. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>

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
