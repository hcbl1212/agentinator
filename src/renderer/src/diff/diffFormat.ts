import type { EventPayloads, StoredEvent } from '../../../shared/events'

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/**
 * Classifies each line of a unified patch for diff-level syntax coloring —
 * add / delete / hunk header / file-meta / context. This is deliberately
 * lexical (no language parsing); per-language highlighting can layer on later.
 */
export function parseDiffLines(patch: string): DiffLine[] {
  if (patch === '') {
    return []
  }
  return patch.split('\n').map((text) => ({ kind: classify(text), text }))
}

function classify(line: string): DiffLineKind {
  if (line.startsWith('@@')) {
    return 'hunk'
  }
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff ') ||
    line.startsWith('index ')
  ) {
    return 'meta'
  }
  if (line.startsWith('+')) {
    return 'add'
  }
  if (line.startsWith('-')) {
    return 'del'
  }
  return 'context'
}

export interface FileDiff {
  path: string
  additions: number
  deletions: number
  lines: DiffLine[]
}

/** Shapes stored file.diffed events into per-file diffs for rendering. */
export function toFileDiffs(events: StoredEvent[]): FileDiff[] {
  return events.map((event) => {
    const payload = event.payload as EventPayloads['file.diffed']
    return {
      path: payload.path,
      additions: payload.additions,
      deletions: payload.deletions,
      lines: parseDiffLines(payload.patch),
    }
  })
}

/** Merge a live file.diffed event into the current per-path diff set. */
export function mergeDiff(current: StoredEvent[], incoming: StoredEvent): StoredEvent[] {
  const path = (incoming.payload as EventPayloads['file.diffed']).path
  const others = current.filter(
    (event) => (event.payload as EventPayloads['file.diffed']).path !== path,
  )
  return [...others, incoming]
}
