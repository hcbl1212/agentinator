import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { DevServers, linkNodeModules, spawnDevServer } from './devServers'
import type { DevServerProcess } from './devServers'

interface FakeProcess extends DevServerProcess {
  kill: ReturnType<typeof vi.fn<() => void>>
  emitStdout: (chunk: string) => void
  emitStderr: (chunk: string) => void
  emitExit: () => void
}

function fakeProcess(): FakeProcess {
  const out: ((chunk: unknown) => void)[] = []
  const err: ((chunk: unknown) => void)[] = []
  const exit: (() => void)[] = []
  return {
    stdout: { on: (_e, listener) => out.push(listener) },
    stderr: { on: (_e, listener) => err.push(listener) },
    on: (_e, listener) => exit.push(listener),
    kill: vi.fn<() => void>(),
    emitStdout: (chunk) => out.forEach((listener) => listener(chunk)),
    emitStderr: (chunk) => err.forEach((listener) => listener(chunk)),
    emitExit: () => exit.forEach((listener) => listener()),
  }
}

function setup(): {
  manager: DevServers
  spawn: ReturnType<typeof vi.fn>
  linkModules: ReturnType<typeof vi.fn>
  procs: FakeProcess[]
} {
  const procs: FakeProcess[] = []
  const spawn = vi.fn(() => {
    const proc = fakeProcess()
    procs.push(proc)
    return proc
  })
  const linkModules = vi.fn()
  const manager = new DevServers({ spawn, linkModules, timeoutMs: 5000 })
  return { manager, spawn, linkModules, procs }
}

describe('DevServers', () => {
  it('links node_modules, spawns the command, and resolves the parsed URL', async () => {
    const { manager, spawn, linkModules, procs } = setup()

    const pending = manager.ensure('s1', '/wt/frontend', '/repo/frontend', 'npm run dev')
    // Noise first (no URL), then Vite's Local line — only the URL line resolves.
    procs[0]?.emitStdout('VITE v7 starting…\n')
    procs[0]?.emitStdout('  ➜  Local:   http://localhost:5173/\n')

    await expect(pending).resolves.toBe('http://localhost:5173')
    expect(linkModules).toHaveBeenCalledWith('/wt/frontend', '/repo/frontend')
    expect(spawn).toHaveBeenCalledWith('npm run dev', '/wt/frontend')
    expect(manager.urlFor('s1')).toBe('http://localhost:5173')
  })

  it('resolves under the default timeout when none is configured', async () => {
    const proc = fakeProcess()
    // No timeoutMs → the built-in default is used for the readiness timer.
    const manager = new DevServers({ spawn: () => proc, linkModules: vi.fn() })
    const pending = manager.ensure('s1', '/wt', '/repo', 'cmd')
    proc.emitStdout('Local: http://localhost:5173/')

    await expect(pending).resolves.toBe('http://localhost:5173')
  })

  it('reuses a running server instead of spawning again', async () => {
    const { manager, spawn, procs } = setup()
    const pending = manager.ensure('s1', '/wt', '/repo', 'cmd')
    procs[0]?.emitStdout('Local: http://localhost:5173/')
    await pending

    await expect(manager.ensure('s1', '/wt', '/repo', 'cmd')).resolves.toBe('http://localhost:5173')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('parses the URL from stderr and strips ANSI colour codes', async () => {
    const { manager, procs } = setup()
    const pending = manager.ensure('s1', '/wt', '/repo', 'cmd')
    const esc = String.fromCharCode(27)
    procs[0]?.emitStderr(`${esc}[32mLocal:${esc}[0m http://127.0.0.1:4321/\n`)

    await expect(pending).resolves.toBe('http://127.0.0.1:4321')
  })

  it('drops a server from the map when its process exits', async () => {
    const { manager, procs } = setup()
    const pending = manager.ensure('s1', '/wt', '/repo', 'cmd')
    procs[0]?.emitStdout('Local: http://localhost:5173/')
    await pending

    procs[0]?.emitExit()
    expect(manager.urlFor('s1')).toBeUndefined()
  })

  it('rejects when the server exits before reporting a URL', async () => {
    const { manager, procs } = setup()
    const pending = manager.ensure('s1', '/wt', '/repo', 'cmd')
    procs[0]?.emitExit()

    await expect(pending).rejects.toThrow('exited before reporting a URL')
  })

  it('rejects and kills the process when no URL arrives before the timeout', async () => {
    vi.useFakeTimers()
    try {
      const { manager, procs } = setup()
      const caught = manager.ensure('s1', '/wt', '/repo', 'cmd').catch((e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(5000)

      expect(await caught).toContain('did not report a URL in time')
      expect(procs[0]?.kill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops one server, and is a no-op for an unknown session', async () => {
    const { manager, procs } = setup()
    const pending = manager.ensure('s1', '/wt', '/repo', 'cmd')
    procs[0]?.emitStdout('Local: http://localhost:5173/')
    await pending

    manager.stop('unknown') // no throw, nothing killed
    expect(procs[0]?.kill).not.toHaveBeenCalled()

    manager.stop('s1')
    expect(procs[0]?.kill).toHaveBeenCalledOnce()
    expect(manager.urlFor('s1')).toBeUndefined()
  })

  it('stops every server on stopAll', async () => {
    const { manager, procs } = setup()
    const a = manager.ensure('s1', '/wt1', '/repo', 'cmd')
    procs[0]?.emitStdout('Local: http://localhost:5173/')
    await a
    const b = manager.ensure('s2', '/wt2', '/repo', 'cmd')
    procs[1]?.emitStdout('Local: http://localhost:5174/')
    await b

    manager.stopAll()

    expect(procs[0]?.kill).toHaveBeenCalledOnce()
    expect(procs[1]?.kill).toHaveBeenCalledOnce()
    expect(manager.urlFor('s1')).toBeUndefined()
    expect(manager.urlFor('s2')).toBeUndefined()
  })
})

describe('spawnDevServer', () => {
  it('runs the command string through a shell in the cwd', () => {
    spawnMock.mockReturnValue({ fake: 'process' })

    const proc = spawnDevServer('npm run dev', '/wt/frontend')

    expect(spawnMock).toHaveBeenCalledWith('npm run dev', { cwd: '/wt/frontend', shell: true })
    expect(proc).toEqual({ fake: 'process' })
  })
})

describe('linkNodeModules', () => {
  it('symlinks the source node_modules when the worktree has none', () => {
    const source = mkdtempSync(join(tmpdir(), 'agentinator-src-'))
    const serverCwd = mkdtempSync(join(tmpdir(), 'agentinator-wt-'))
    mkdirSync(join(source, 'node_modules'))

    linkNodeModules(serverCwd, source)

    const linked = join(serverCwd, 'node_modules')
    expect(existsSync(linked)).toBe(true)
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    rmSync(source, { recursive: true, force: true })
    rmSync(serverCwd, { recursive: true, force: true })
  })

  it('does nothing when the worktree already has node_modules', () => {
    const source = mkdtempSync(join(tmpdir(), 'agentinator-src-'))
    const serverCwd = mkdtempSync(join(tmpdir(), 'agentinator-wt-'))
    mkdirSync(join(source, 'node_modules'))
    mkdirSync(join(serverCwd, 'node_modules')) // already present (a real dir)

    linkNodeModules(serverCwd, source)

    expect(lstatSync(join(serverCwd, 'node_modules')).isSymbolicLink()).toBe(false)
    rmSync(source, { recursive: true, force: true })
    rmSync(serverCwd, { recursive: true, force: true })
  })

  it('does nothing when the source has no node_modules to link', () => {
    const source = mkdtempSync(join(tmpdir(), 'agentinator-src-'))
    const serverCwd = mkdtempSync(join(tmpdir(), 'agentinator-wt-'))

    linkNodeModules(serverCwd, source)

    expect(existsSync(join(serverCwd, 'node_modules'))).toBe(false)
    rmSync(source, { recursive: true, force: true })
    rmSync(serverCwd, { recursive: true, force: true })
  })
})
