import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  COMPONENT_ENTRY,
  ComponentWorkbench,
  WRAPPER_FILE,
  componentEntryHtml,
  nodeWorkbenchFs,
} from './componentWorkbench'

describe('componentEntryHtml', () => {
  it('picks the export namespace-agnostically and mounts across React versions', () => {
    const html = componentEntryHtml({ importPath: '/src/components/Cart.tsx', exportName: 'Cart' })
    // Namespace import so default OR named exports work; no static react-dom/client.
    expect(html).toContain('import * as mod from "/src/components/Cart.tsx"')
    expect(html).toContain('mod["Cart"]')
    expect(html).toContain("import * as ReactDOM from 'react-dom'")
    // React 18 createRoot when present, else React 17 render, else React 19's
    // dynamic react-dom/client import.
    expect(html).toContain("typeof ReactDOM.createRoot === 'function'")
    expect(html).toContain('ReactDOM.render(element, root)')
    expect(html).toContain("import('react-dom/client')")
    // No wrapper → no wrap import; renders the component directly.
    expect(html).toContain('const Wrapper = null')
    // Shims Node's `global` before the module runs (apps expect it present).
    expect(html).toContain('window.global = window')
  })

  it('wraps the component in a provider when a wrapper is given', () => {
    const html = componentEntryHtml(
      { importPath: '/src/Cart.tsx', exportName: 'Cart' },
      { importPath: '/src/PreviewProviders.tsx', exportName: 'PreviewProviders' },
    )
    expect(html).toContain('import * as wrapMod from "/src/PreviewProviders.tsx"')
    expect(html).toContain('wrapMod["PreviewProviders"]')
    expect(html).toContain('Wrapper ? createElement(Wrapper, null, inner) : inner')
  })

  it('renders with props when a props literal is given, else undefined', () => {
    const withProps = componentEntryHtml(
      { importPath: '/src/Cart.tsx', exportName: 'Cart' },
      undefined,
      '{ completedValue: 3, totalValue: 10 }',
    )
    expect(withProps).toContain('const props = ({ completedValue: 3, totalValue: 10 })')
    expect(withProps).toContain('createElement(Component, props)')

    const noProps = componentEntryHtml({ importPath: '/src/Cart.tsx', exportName: 'Cart' })
    expect(noProps).toContain('const props = undefined')
  })
})

describe('ComponentWorkbench', () => {
  it('writes the entry and passes the file base name as the likely export', () => {
    const writes: { path: string; content: string }[] = []
    const workbench = new ComponentWorkbench({
      write: (path, content) => writes.push({ path, content }),
      remove: vi.fn(),
    })

    const url = workbench.prepare('/app', 'src/components/EmployerDashboard/EmailMigrationPage.tsx')

    expect(url).toBe('/__agentinator_component.html')
    expect(writes[0]?.path).toBe(join('/app', COMPONENT_ENTRY))
    expect(writes[0]?.content).toContain(
      'import * as mod from "/src/components/EmployerDashboard/EmailMigrationPage.tsx"',
    )
    expect(writes[0]?.content).toContain('mod["EmailMigrationPage"]')
    expect(writes[0]?.content).toContain('const Wrapper = null')
  })

  it('includes the wrapper when one is provided', () => {
    const writes: { content: string }[] = []
    const workbench = new ComponentWorkbench({
      write: (_path, content) => writes.push({ content }),
      remove: vi.fn(),
    })

    workbench.prepare('/app', 'src/Cart.tsx', 'src/PreviewProviders.tsx')

    expect(writes[0]?.content).toContain('import * as wrapMod from "/src/PreviewProviders.tsx"')
    expect(writes[0]?.content).toContain('wrapMod["PreviewProviders"]')
  })

  it('normalizes a leading slash and backslashes in the component path', () => {
    const writes: { content: string }[] = []
    const workbench = new ComponentWorkbench({
      write: (_path, content) => writes.push({ content }),
      remove: vi.fn(),
    })

    workbench.prepare('/app', '\\src\\ui\\Button.tsx', '')

    expect(writes[0]?.content).toContain('import * as mod from "/src/ui/Button.tsx"')
    expect(writes[0]?.content).toContain('mod["Button"]')
    // A blank wrapper is treated as none.
    expect(writes[0]?.content).toContain('const Wrapper = null')
  })

  it('writes an agent-generated wrapper and returns its name', () => {
    const writes: { path: string; content: string }[] = []
    const workbench = new ComponentWorkbench({
      write: (path, content) => writes.push({ path, content }),
      remove: vi.fn(),
    })

    const name = workbench.writeWrapper('/app', 'export default ({ children }) => children')

    expect(name).toBe(WRAPPER_FILE)
    expect(writes[0]?.path).toBe(join('/app', WRAPPER_FILE))
    expect(writes[0]?.content).toContain('export default')
  })

  it('removes the entry and the generated wrapper on clear', () => {
    const remove = vi.fn()
    new ComponentWorkbench({ write: vi.fn(), remove }).clear('/app')

    expect(remove).toHaveBeenCalledWith(join('/app', COMPONENT_ENTRY))
    expect(remove).toHaveBeenCalledWith(join('/app', WRAPPER_FILE))
  })
})

describe('nodeWorkbenchFs', () => {
  it('writes and removes a real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-workbench-'))
    const path = join(dir, COMPONENT_ENTRY)

    nodeWorkbenchFs.write(path, '<html></html>')
    expect(existsSync(path)).toBe(true)

    nodeWorkbenchFs.remove(path)
    expect(existsSync(path)).toBe(false)
    // Removing again is safe (force).
    nodeWorkbenchFs.remove(path)
  })
})
