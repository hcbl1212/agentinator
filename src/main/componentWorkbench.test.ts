import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  COMPONENT_ENTRY,
  ComponentWorkbench,
  componentEntryHtml,
  nodeWorkbenchFs,
} from './componentWorkbench'

describe('componentEntryHtml', () => {
  it('picks the export namespace-agnostically and mounts across React versions', () => {
    const html = componentEntryHtml('/src/components/Cart.tsx', 'Cart')
    // Namespace import so default OR named exports work; no static react-dom/client.
    expect(html).toContain('import * as mod from "/src/components/Cart.tsx"')
    expect(html).toContain('mod["Cart"]')
    expect(html).toContain("import * as ReactDOM from 'react-dom'")
    // React 18 createRoot when present, else React 17 render.
    expect(html).toContain("typeof ReactDOM.createRoot === 'function'")
    expect(html).toContain('ReactDOM.render(element, root)')
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
  })

  it('normalizes a leading slash and backslashes in the component path', () => {
    const writes: { content: string }[] = []
    const workbench = new ComponentWorkbench({
      write: (_path, content) => writes.push({ content }),
      remove: vi.fn(),
    })

    workbench.prepare('/app', '\\src\\ui\\Button.tsx')

    expect(writes[0]?.content).toContain('import * as mod from "/src/ui/Button.tsx"')
    expect(writes[0]?.content).toContain('mod["Button"]')
  })

  it('removes the entry on clear', () => {
    const remove = vi.fn()
    new ComponentWorkbench({ write: vi.fn(), remove }).clear('/app')

    expect(remove).toHaveBeenCalledWith(join('/app', COMPONENT_ENTRY))
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
