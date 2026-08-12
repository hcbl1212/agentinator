import { spawn } from 'node:child_process'
import { existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

/** The slice of a spawned dev-server process the manager needs — kept minimal
 * and structural so tests can supply a fake without a real child process. */
export interface DevServerProcess {
  stdout: { on(event: 'data', listener: (chunk: unknown) => void): void }
  stderr: { on(event: 'data', listener: (chunk: unknown) => void): void }
  on(event: 'exit', listener: () => void): void
  kill(): void
}

/** Starts the dev-server command in a directory, returning the live process. */
export type SpawnDevServer = (command: string, cwd: string) => DevServerProcess

export interface DevServersDeps {
  spawn: SpawnDevServer
  /** Make node_modules available in the worktree's server dir (the checkout has
   * none — it's gitignored) by linking the main checkout's. A no-op if the
   * target already has one or the source is absent. */
  linkModules: (serverCwd: string, sourceCwd: string) => void
  /** How long to wait for the server to print its URL before giving up (ms). */
  timeoutMs?: number
}

/** The real spawn: runs the command string through a shell in `cwd`. */
export const spawnDevServer: SpawnDevServer = (command, cwd) => spawn(command, { cwd, shell: true })

/** Make the main checkout's node_modules available in a worktree's server dir —
 * a fresh worktree has none (gitignored). No-op if the target already has one
 * or the source is absent. */
export function linkNodeModules(serverCwd: string, sourceCwd: string): void {
  const target = join(serverCwd, 'node_modules')
  const source = join(sourceCwd, 'node_modules')
  if (!existsSync(target) && existsSync(source)) {
    symlinkSync(source, target, 'dir')
  }
}

// ANSI colour codes wrap Vite's "Local:" line — strip them before matching.
// Built from a char code so the source has no literal control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const LOCAL_URL = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+)/i
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Runs one dev server per agent worktree so an isolated agent's edits can be
 * previewed on its own branch. Servers are keyed by session id, started on
 * demand and reused, and torn down on request or app quit. The spawn and
 * node_modules link are injected so the lifecycle is testable without really
 * launching Vite.
 */
export class DevServers {
  #deps: DevServersDeps
  #servers = new Map<string, { process: DevServerProcess; url: string }>()

  constructor(deps: DevServersDeps) {
    this.#deps = deps
  }

  /** The running server URL for a session, or undefined. */
  urlFor(sessionId: string): string | undefined {
    return this.#servers.get(sessionId)?.url
  }

  /**
   * Ensure a dev server is running for `sessionId` in `serverCwd` (linking
   * node_modules from `sourceCwd` first), resolving to its URL. Idempotent: a
   * session's server is started once and reused.
   */
  async ensure(
    sessionId: string,
    serverCwd: string,
    sourceCwd: string,
    command: string,
  ): Promise<string> {
    const existing = this.#servers.get(sessionId)
    if (existing !== undefined) {
      return existing.url
    }
    this.#deps.linkModules(serverCwd, sourceCwd)
    const process = this.#deps.spawn(command, serverCwd)
    const url = await this.#awaitUrl(process)
    this.#servers.set(sessionId, { process, url })
    process.on('exit', () => {
      this.#servers.delete(sessionId)
    })
    return url
  }

  /** Stop a session's dev server, if any. */
  stop(sessionId: string): void {
    const server = this.#servers.get(sessionId)
    if (server !== undefined) {
      server.process.kill()
      this.#servers.delete(sessionId)
    }
  }

  /** Stop every dev server — called on app quit. */
  stopAll(): void {
    for (const server of this.#servers.values()) {
      server.process.kill()
    }
    this.#servers.clear()
  }

  /** Resolve the server's URL from its output, or reject if it exits first or
   * never reports one within the timeout. */
  #awaitUrl(process: DevServerProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          fn()
        }
      }
      const onData = (chunk: unknown): void => {
        const match = LOCAL_URL.exec(String(chunk).replace(ANSI, ''))
        if (match !== null) {
          finish(() => resolve(match[1]))
        }
      }
      process.stdout.on('data', onData)
      process.stderr.on('data', onData)
      process.on('exit', () => {
        finish(() => reject(new Error('Dev server exited before reporting a URL')))
      })
      const timer = setTimeout(() => {
        finish(() => {
          process.kill()
          reject(new Error('Dev server did not report a URL in time'))
        })
      }, this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
  }
}
