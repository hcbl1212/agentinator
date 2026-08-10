import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The entry file the workbench drops at the app root; the dev server (Vite)
 * serves it at `/<COMPONENT_ENTRY>`. Distinctive so it's obvious it's ours. */
export const COMPONENT_ENTRY = '__agentinator_component.html'

/** An agent-generated wrapper module the workbench writes at the app root. */
export const WRAPPER_FILE = '__agentinator_wrapper.tsx'

/** A standalone page that mounts one React component through the app's own
 * module graph — bare imports (`react`) and the `/src/...` import resolve via
 * the running Vite, so the component renders with the app's real deps. No JSX
 * in the inline script (Vite doesn't transform those), hence createElement.
 *
 * The component (and an optional wrapper that provides app context — store,
 * router, i18n) is picked without assuming how it's exported: a default export,
 * then a named export matching the file, then the first function export. When a
 * wrapper is given the component renders as its children. Mounting is
 * version-agnostic — React 18's createRoot when available, else React 17's
 * render (no static `react-dom/client` import, which doesn't exist on 17). */
export interface EntryModule {
  importPath: string
  exportName: string
}

export function componentEntryHtml(
  component: EntryModule,
  wrapper?: EntryModule,
  props?: string,
): string {
  const pick = (variable: string, mod: string, entry: EntryModule): string =>
    `import * as ${mod} from ${JSON.stringify(entry.importPath)}\n` +
    `      const ${variable} = ${mod}.default ?? ${mod}[${JSON.stringify(entry.exportName)}] ?? ` +
    `Object.values(${mod}).find((value) => typeof value === 'function')`
  const wrapperImport =
    wrapper === undefined ? 'const Wrapper = null' : pick('Wrapper', 'wrapMod', wrapper)
  // Props are a JS object literal (author- or agent-supplied) rendered into the
  // component; wrapped in parens so it's an expression, undefined when absent.
  const propsExpr = props === undefined || props.trim() === '' ? 'undefined' : `(${props})`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Component workbench</title>
    <!-- Many app bundles reference Node's \`global\`; the app's own index.html
         shims it, but this isolated entry doesn't include that HTML. A plain
         (non-module) script runs before the deferred module below, so the
         shim is in place before any dependency dereferences \`global\`. -->
    <script>
      window.global = window
    </script>
  </head>
  <body>
    <div id="agentinator-root"></div>
    <script type="module">
      import { createElement } from 'react'
      import * as ReactDOM from 'react-dom'
      ${pick('Component', 'mod', component)}
      ${wrapperImport}
      const props = ${propsExpr}
      const root = document.getElementById('agentinator-root')
      if (Component) {
        const inner = createElement(Component, props)
        const element = Wrapper ? createElement(Wrapper, null, inner) : inner
        if (typeof ReactDOM.createRoot === 'function') {
          ReactDOM.createRoot(root).render(element)
        } else {
          ReactDOM.render(element, root)
        }
      } else {
        root.textContent = 'No component export found in ${component.importPath}'
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

  /** Write the entry into `root` importing `file` (and an optional `wrapper`,
   * both root-relative), and return the dev-server URL path to preview. The
   * file's base name is used as the likely export name (e.g.
   * `EmailMigrationPage.tsx` → `EmailMigrationPage`). */
  prepare(root: string, file: string, wrapper?: string, props?: string): string {
    const entry = (path: string): EntryModule => {
      const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
      const base = normalized.substring(normalized.lastIndexOf('/') + 1)
      return { importPath: `/${normalized}`, exportName: base.replace(/\.[^.]+$/, '') }
    }
    const wrap = wrapper === undefined || wrapper === '' ? undefined : entry(wrapper)
    this.#fs.write(join(root, COMPONENT_ENTRY), componentEntryHtml(entry(file), wrap, props))
    return `/${COMPONENT_ENTRY}`
  }

  /** Write an agent-generated wrapper module at the app root and return its
   * root-relative name (to use as the wrapper file). */
  writeWrapper(root: string, source: string): string {
    this.#fs.write(join(root, WRAPPER_FILE), source)
    return WRAPPER_FILE
  }

  /** Remove the entry and any generated wrapper from `root` (best-effort). */
  clear(root: string): void {
    this.#fs.remove(join(root, COMPONENT_ENTRY))
    this.#fs.remove(join(root, WRAPPER_FILE))
  }
}
