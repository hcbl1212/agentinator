import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The entry file the workbench drops at the app root; the dev server (Vite)
 * serves it at `/<COMPONENT_ENTRY>`. Distinctive so it's obvious it's ours. */
export const COMPONENT_ENTRY = '__agentinator_component.html'

/** A standalone page that mounts one React component through the app's own
 * module graph — bare imports (`react`) and the `/src/...` import resolve via
 * the running Vite, so the component renders with the app's real deps. No JSX
 * in the inline script (Vite doesn't transform those), hence createElement.
 *
 * The component is picked without assuming how it's exported: a default export,
 * then a named export matching the file (e.g. `EmailMigrationPage`), then the
 * first function export. Mounting is version-agnostic — React 18's createRoot
 * when available, else React 17's render (no static `react-dom/client` import,
 * which doesn't exist on 17). If no component is found the page says so. */
export function componentEntryHtml(importPath: string, exportName: string): string {
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
      import * as ReactDOM from 'react-dom'
      import * as mod from ${JSON.stringify(importPath)}
      const Component =
        mod.default ??
        mod[${JSON.stringify(exportName)}] ??
        Object.values(mod).find((value) => typeof value === 'function')
      const root = document.getElementById('agentinator-root')
      if (Component) {
        const element = createElement(Component)
        if (typeof ReactDOM.createRoot === 'function') {
          ReactDOM.createRoot(root).render(element)
        } else {
          ReactDOM.render(element, root)
        }
      } else {
        root.textContent = 'No component export found in ${importPath}'
      }
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
   * the dev-server URL path to preview. The file's base name is passed as the
   * likely export name (e.g. `EmailMigrationPage.tsx` → `EmailMigrationPage`). */
  prepare(root: string, file: string): string {
    const normalized = file.replace(/\\/g, '/').replace(/^\/+/, '')
    const base = normalized.substring(normalized.lastIndexOf('/') + 1)
    const exportName = base.replace(/\.[^.]+$/, '')
    this.#fs.write(join(root, COMPONENT_ENTRY), componentEntryHtml(`/${normalized}`, exportName))
    return `/${COMPONENT_ENTRY}`
  }

  /** Remove the entry from `root` (best-effort — safe if it was never written). */
  clear(root: string): void {
    this.#fs.remove(join(root, COMPONENT_ENTRY))
  }
}
