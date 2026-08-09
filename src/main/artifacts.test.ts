import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { FileArtifactStore } from './artifacts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentinator-artifacts-'))
})

describe('FileArtifactStore', () => {
  it('round-trips bytes through a generated ref', () => {
    const store = new FileArtifactStore(dir)
    const bytes = new Uint8Array([1, 2, 3, 250])

    const ref = store.put(bytes)

    expect(ref).toMatch(/^shot_/)
    expect(store.read(ref)).toEqual(Buffer.from(bytes))
  })

  it('creates the directory if it does not exist yet', () => {
    const nested = join(dir, 'deep', 'shots')
    const store = new FileArtifactStore(nested)

    const ref = store.put(new Uint8Array([9]))

    expect(store.read(ref)).toEqual(Buffer.from([9]))
  })

  it('returns undefined for an unknown ref', () => {
    const store = new FileArtifactStore(dir)

    expect(store.read('shot_missing')).toBeUndefined()
  })
})
