import { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import { EventStore } from './eventStore'
import { createClaudeProvider } from './providers/claude'
import type { ClaudeQuery } from './providers/claude'
import { SessionManager } from './sessions'

/**
 * Opt-in dogfood proof: drives the REAL Claude provider through the real
 * SessionManager on THIS repo — the exact path the UI's "Run task" button
 * uses — with a trivial read-only prompt. Auth comes from the machine's
 * Claude Code login (a subscription works). Gated behind CLAUDE_SMOKE so CI
 * and normal test runs never touch the network:
 *
 *   npm run smoke:dogfood
 */
describe.skipIf(process.env['CLAUDE_SMOKE'] === undefined)('dogfood (live)', () => {
  it('runs a real Claude task on this repo end to end', { timeout: 180_000 }, async () => {
    const store = new EventStore()
    const types: string[] = []
    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const manager = new SessionManager(store, (event) => {
      types.push(event.type)
      if (event.type === 'session.ended') {
        finish()
      }
    })
    // Auto-approve read-only tool use for the headless run (the UI does this
    // via approval cards); the prompt is deliberately read-only.
    manager.register(
      createClaudeProvider(query as unknown as ClaudeQuery, () => Promise.resolve(true)),
    )

    manager.start({
      providerId: 'claude',
      title: 'Dogfood: count source files',
      prompt:
        'Without modifying anything, tell me how many *.ts files are under the src/ directory. Reply with just the number.',
      cwd: process.cwd(),
    })
    await done

    console.log('event stream:', types.join(' → '))

    const ended = store.list().at(-1)
    expect(ended?.type).toBe('session.ended')
    expect((ended?.payload as { outcome: string }).outcome).toBe('completed')
    expect(types).toContain('cost.usage')
    store.close()
  })
})
