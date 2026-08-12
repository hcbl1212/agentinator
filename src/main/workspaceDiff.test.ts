import { describe, expect, it, vi } from 'vitest'

import type { GitRunner } from './git'
import { diffAgainstHead, parseGitDiff, worktreeDepsChanged } from './workspaceDiff'

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
-old line
+new line
+added line`

const DELETED = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 333..000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-was here
-and here`

const NEW_FILE = `diff --git a/new.ts b/new.ts
new file mode 100644
index 000..444
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line one
+line two`

const MODE_ONLY = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755`

describe('parseGitDiff', () => {
  it('parses a modified file into path, counts, and hunk-body patch', () => {
    expect(parseGitDiff(MODIFIED)).toEqual([
      {
        path: 'src/a.ts',
        additions: 2,
        deletions: 1,
        patch: '@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n+added line',
      },
    ])
  })

  it('resolves a deleted file’s path from the old side', () => {
    const [file] = parseGitDiff(DELETED)
    expect(file).toMatchObject({ path: 'gone.ts', additions: 0, deletions: 2 })
  })

  it('splits a multi-file diff and skips mode-only sections with no hunks', () => {
    const files = parseGitDiff(`${MODIFIED}\n${MODE_ONLY}\n${NEW_FILE}`)
    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'new.ts'])
  })

  it('returns nothing for empty or non-diff output', () => {
    expect(parseGitDiff('')).toEqual([])
    expect(parseGitDiff('not a diff')).toEqual([])
  })
})

describe('diffAgainstHead', () => {
  it('combines tracked changes with untracked files shown as additions', async () => {
    const git: GitRunner = vi.fn((args: string[]) => {
      if (args[0] === 'diff' && args[1] === 'HEAD') {
        return Promise.resolve(MODIFIED)
      }
      if (args[0] === 'ls-files') {
        return Promise.resolve('new.ts\0')
      }
      return Promise.resolve(NEW_FILE) // the --no-index call for new.ts
    })

    const files = await diffAgainstHead('/repo', git)

    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'new.ts'])
    expect(files[1]).toMatchObject({ additions: 2, deletions: 0 })
  })

  it('tolerates a repo with no HEAD and no untracked listing', async () => {
    const git: GitRunner = vi.fn((args: string[]) =>
      args[0] === 'diff' && args[1] === 'HEAD'
        ? Promise.reject(new Error('bad revision HEAD'))
        : Promise.reject(new Error('not a git repository')),
    )

    await expect(diffAgainstHead('/repo', git)).resolves.toEqual([])
  })

  it('skips an untracked file whose --no-index diff fails', async () => {
    const git: GitRunner = vi.fn((args: string[]) => {
      if (args[0] === 'diff' && args[1] === 'HEAD') {
        return Promise.resolve('')
      }
      if (args[0] === 'ls-files') {
        return Promise.resolve('binary.bin\0')
      }
      return Promise.reject(new Error('binary files differ'))
    })

    await expect(diffAgainstHead('/repo', git)).resolves.toEqual([])
  })
})

describe('worktreeDepsChanged', () => {
  const gitReturning = (output: string): GitRunner => vi.fn(() => Promise.resolve(output))

  it('is true when a manifest or lockfile changed (anywhere in the tree)', async () => {
    await expect(
      worktreeDepsChanged('/wt', gitReturning('src/App.tsx\nfrontend/package.json\n')),
    ).resolves.toBe(true)
    await expect(worktreeDepsChanged('/wt', gitReturning('package-lock.json'))).resolves.toBe(true)
  })

  it('is false when only source files changed', async () => {
    await expect(
      worktreeDepsChanged('/wt', gitReturning('src/App.tsx\nsrc/pkg/index.ts\n')),
    ).resolves.toBe(false)
  })

  it('is false (not throwing) when the dir is not a git repo', async () => {
    const git: GitRunner = vi.fn(() => Promise.reject(new Error('not a git repository')))
    await expect(worktreeDepsChanged('/nope', git)).resolves.toBe(false)
  })
})
