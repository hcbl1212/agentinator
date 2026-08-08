import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Electron's own postinstall downloads its binary, but that download can fail
 * silently (proxies, firewalls, sandboxed installs) — leaving `npm run dev`
 * to crash with "Error: Electron uninstall". This runs as our postinstall:
 * if the binary is missing, re-run Electron's installer; if the download
 * fails again, npm install fails loudly instead of deferring the breakage.
 */
export function ensureElectron({
  root = process.cwd(),
  exists = existsSync,
  run = execFileSync,
  log = console.log,
} = {}) {
  const electronDir = join(root, 'node_modules', 'electron')
  if (exists(join(electronDir, 'dist'))) {
    return false
  }
  log('Electron binary missing — running its installer…')
  run(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' })
  return true
}

ensureElectron()
