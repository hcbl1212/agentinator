import type { GitRunner } from './git'

/** One file's cumulative change, in the shape the file.diffed event carries. */
export interface FileDiffData {
  path: string
  additions: number
  deletions: number
  patch: string
}

/** The path a diff section touches — preferring the new side, falling back to
 * the old side for a deletion (where the new side is /dev/null). */
function extractPath(lines: string[]): string | null {
  const strip = (raw: string): string | null => {
    const p = raw.slice(4)
    return p === '/dev/null' ? null : p.replace(/^[ab]\//, '')
  }
  const plus = lines.find((line) => line.startsWith('+++ '))
  const fromPlus = plus === undefined ? null : strip(plus)
  if (fromPlus !== null) {
    return fromPlus
  }
  const minus = lines.find((line) => line.startsWith('--- '))
  return minus === undefined ? null : strip(minus)
}

/**
 * Splits a `git diff` (or `git diff --no-index`) into one entry per file: the
 * path, added/removed line counts, and the hunk body (from the first `@@`) as
 * the patch the DiffView renders. File-mode-only or binary changes with no
 * hunks are skipped.
 */
export function parseGitDiff(output: string): FileDiffData[] {
  const files: FileDiffData[] = []
  for (const section of output.split(/\n(?=diff --git )/)) {
    if (!section.startsWith('diff --git ')) {
      continue
    }
    const lines = section.split('\n')
    const path = extractPath(lines)
    const hunkStart = lines.findIndex((line) => line.startsWith('@@'))
    if (path === null || hunkStart === -1) {
      continue
    }
    const body = lines.slice(hunkStart)
    let additions = 0
    let deletions = 0
    for (const line of body) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions += 1
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions += 1
      }
    }
    files.push({ path, additions, deletions, patch: body.join('\n') })
  }
  return files
}

/**
 * The agent's cumulative changes in a working dir versus HEAD: modified/deleted
 * tracked files (`git diff HEAD`) plus new files (each shown as all-additions
 * via `git diff --no-index`, which never touches the index). Best-effort — a
 * dir with no HEAD or no git returns nothing rather than throwing.
 */
export async function diffAgainstHead(cwd: string, git: GitRunner): Promise<FileDiffData[]> {
  const tracked = await git(['diff', 'HEAD', '--no-color'], cwd)
    .then(parseGitDiff)
    .catch(() => [] as FileDiffData[])

  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).catch(
    () => '',
  )
  const untrackedPaths = listed.split('\0').filter((path) => path !== '')

  const untracked: FileDiffData[] = []
  for (const path of untrackedPaths) {
    const out = await git(['diff', '--no-index', '--no-color', '/dev/null', path], cwd).catch(
      () => '',
    )
    untracked.push(...parseGitDiff(out))
  }

  return [...tracked, ...untracked]
}
