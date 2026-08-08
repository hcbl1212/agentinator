import { describe, expect, it, vi } from 'vitest'

import { ensureElectron } from './ensure-electron.mjs'

describe('ensureElectron', () => {
  it('does nothing when the Electron binary is already present', () => {
    const run = vi.fn()

    const downloaded = ensureElectron({ root: '/repo', exists: () => true, run })

    expect(downloaded).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('runs the Electron installer when the binary is missing', () => {
    const run = vi.fn()
    const log = vi.fn()

    const downloaded = ensureElectron({ root: '/repo', exists: () => false, run, log })

    expect(downloaded).toBe(true)
    expect(log).toHaveBeenCalledWith('Electron binary missing — running its installer…')
    expect(run).toHaveBeenCalledWith(process.execPath, ['/repo/node_modules/electron/install.js'], {
      stdio: 'inherit',
    })
  })
})
