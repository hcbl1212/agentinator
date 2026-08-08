import { describe, expect, it } from 'vitest'

import type { EventPayloads, StoredEvent } from '../../../shared/events'
import { mergeDiff, parseDiffLines, toFileDiffs } from './diffFormat'

function diffEvent(path: string, patch: string, seq = 1): StoredEvent {
  return {
    seq,
    ts: 't',
    type: 'file.diffed',
    payload: { sessionId: 's', path, additions: 1, deletions: 0, patch },
  } as StoredEvent
}

describe('parseDiffLines', () => {
  it('classifies each line of a unified patch', () => {
    const lines = parseDiffLines(
      [
        'diff --git a/x.ts b/x.ts',
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,2 +1,3 @@',
        ' unchanged',
        '-removed',
        '+added',
      ].join('\n'),
    )

    expect(lines.map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'del',
      'add',
    ])
  })

  it('classifies an index line as meta', () => {
    expect(parseDiffLines('index abc..def 100644')[0]?.kind).toBe('meta')
  })

  it('returns nothing for an empty patch', () => {
    expect(parseDiffLines('')).toEqual([])
  })
})

describe('toFileDiffs', () => {
  it('shapes events into per-file diffs with parsed lines', () => {
    const diffs = toFileDiffs([diffEvent('a.ts', '+one\n+two')])

    expect(diffs[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 0 })
    expect(diffs[0]?.lines.map((line) => line.kind)).toEqual(['add', 'add'])
  })
})

describe('mergeDiff', () => {
  it('replaces the entry for the same path and appends new paths', () => {
    const initial = [diffEvent('a.ts', 'v1', 1), diffEvent('b.ts', 'b', 2)]

    const updatedA = mergeDiff(initial, diffEvent('a.ts', 'v2', 3))
    expect(updatedA.map((event) => (event.payload as EventPayloads['file.diffed']).patch)).toEqual([
      'b',
      'v2',
    ])

    const withC = mergeDiff(updatedA, diffEvent('c.ts', 'c', 4))
    expect(withC).toHaveLength(3)
  })
})
