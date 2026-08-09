import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Stores binary artifacts (screenshots, later baselines/crops) OUTSIDE the
 * event log — the log keeps only a `ref`. Keeps the append-only DB lean and
 * lets big PNGs live as real files. Vendor-neutral; the preview layer neither
 * knows nor cares where the bytes land.
 */
export interface ArtifactStore {
  /** Persist bytes and return a stable ref that `read` round-trips. */
  put(bytes: Uint8Array): string
  /** The bytes for a ref, or undefined if it's unknown or gone. */
  read(ref: string): Uint8Array | undefined
}

/** Filesystem-backed store: one file per artifact under a directory. */
export class FileArtifactStore implements ArtifactStore {
  #dir: string

  constructor(dir: string) {
    this.#dir = dir
    mkdirSync(dir, { recursive: true })
  }

  put(bytes: Uint8Array): string {
    const ref = `shot_${crypto.randomUUID()}`
    writeFileSync(this.#path(ref), bytes)
    return ref
  }

  read(ref: string): Uint8Array | undefined {
    const path = this.#path(ref)
    return existsSync(path) ? readFileSync(path) : undefined
  }

  #path(ref: string): string {
    return join(this.#dir, `${ref}.png`)
  }
}
