import { tmpdir } from 'node:os'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

/**
 * Opt-in proof of the mechanism behind "switch to API key": the SDK reports
 * which credential it used (`apiKeySource` on the init message), and its `env`
 * option can force a different one. This is the verify-before-build step for
 * C2 — we confirm the switch is observable and steerable before wiring UI.
 * Gated behind CLAUDE_SMOKE:
 *
 *   npm run smoke:auth
 */
describe.skipIf(process.env['CLAUDE_SMOKE'] === undefined)('auth source (live)', () => {
  it('reports the credential source, and honors an env override when a key exists', async () => {
    const sourceUnder = async (env?: Record<string, string>): Promise<string> => {
      const q = query({
        prompt: 'Reply with just: OK',
        options: env === undefined ? { cwd: tmpdir() } : { cwd: tmpdir(), env },
      })
      let source = 'unknown'
      for await (const message of q) {
        if (
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'system' &&
          (message as { subtype?: unknown }).subtype === 'init'
        ) {
          source = String((message as { apiKeySource?: unknown }).apiKeySource)
          break
        }
      }
      return source
    }

    const ambient = await sourceUnder()
    console.log('ambient apiKeySource:', ambient)
    expect(typeof ambient).toBe('string')
    expect(ambient).not.toBe('unknown')

    // Inject a key ONLY via Options.env (from a distinct var, so the ambient
    // login stays the subscription). If the override works, the forced source
    // must differ from the ambient one — proving env beats the subscription.
    const key = process.env['AGENTINATOR_API_KEY']
    if (key !== undefined && key !== '') {
      const forced = await sourceUnder({ ...process.env, ANTHROPIC_API_KEY: key })
      console.log('forced apiKeySource:', forced)
      expect(forced).not.toBe(ambient)
      expect(forced).not.toBe('none')
      expect(forced).not.toBe('oauth')
    } else {
      console.log('(set AGENTINATOR_API_KEY to exercise the override)')
    }
  })
})
