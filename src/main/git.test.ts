import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { runGit } from './git'

type ExecCb = (error: unknown, stdout: string) => void

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runGit', () => {
  it('runs git with the args and cwd and resolves stdout', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb: ExecCb) => cb(null, 'the diff'))

    await expect(runGit(['diff', 'HEAD'], '/repo')).resolves.toBe('the diff')
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['diff', 'HEAD'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    )
  })

  it('treats exit code 1 (differences found) as success', async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb: ExecCb) =>
      cb({ code: 1 }, 'a diff with changes'),
    )

    await expect(runGit(['diff', '--no-index', '/dev/null', 'x'], '/repo')).resolves.toBe(
      'a diff with changes',
    )
  })

  it('rejects on a real git error (e.g. not a repo)', async () => {
    const failure = Object.assign(new Error('fatal: not a git repository'), { code: 128 })
    execFileMock.mockImplementation((_bin, _args, _opts, cb: ExecCb) => cb(failure, ''))

    await expect(runGit(['diff', 'HEAD'], '/nope')).rejects.toThrow('not a git repository')
  })
})
