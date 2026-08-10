import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The entry file the workbench drops at the app root; the dev server (Vite)
 * serves it at `/<COMPONENT_ENTRY>`. Distinctive so it's obvious it's ours. */
export const COMPONENT_ENTRY = '__agentinator_component.html'

/** A standalone page that mounts one React component through the app's own
 * module graph — bare imports (`react`) and the `/src/...` import resolve via
 * the running Vite, so the component renders with the app's real deps. No JSX
 * in the inline script (Vite doesn't transform those), hence createElement. */
export function componentEntryHtml(importPath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Component workbench</title>
  </head>
  <body>
    <div id="agentinator-root"></div>
    <script type="module">
      import { createElement } from 'react'
      import { createRoot } from 'react-dom/client'
      import Component from ${JSON.stringify(importPath)}
      createRoot(document.getElementById('agentinator-root')).render(createElement(Component))
    </script>
  </body>
</html>
`
}

/** File operations the workbench needs — injected so the logic is testable
 * without touching a real project directory. */
export interface WorkbenchFs {
  write(path: string, content: string): void
  remove(path: string): void
}

export const nodeWorkbenchFs: WorkbenchFs = {
  write: (path, content) => {
    writeFileSync(path, content)
  },
  remove: (path) => {
    rmSync(path, { force: true })
  },
}

/**
 * Renders a single component in isolation by writing an entry at the app root
 * that imports it and mounting it through the app's running dev server — so
 * capture / console / network / point-at-it all work on just that component.
 */
export class ComponentWorkbench {
  #fs: WorkbenchFs

  constructor(fs: WorkbenchFs = nodeWorkbenchFs) {
    this.#fs = fs
  }

  /** Write the entry into `root` importing `file` (root-relative), and return
   * the dev-server URL path to preview. */
  prepare(root: string, file: string): string {
    const importPath = `/${file.replace(/\\/g, '/').replace(/^\/+/, '')}`
    this.#fs.write(join(root, COMPONENT_ENTRY), componentEntryHtml(importPath))
    return `/${COMPONENT_ENTRY}`
  }

  /** Remove the entry from `root` (best-effort — safe if it was never written). */
  clear(root: string): void {
    this.#fs.remove(join(root, COMPONENT_ENTRY))
  }
}
