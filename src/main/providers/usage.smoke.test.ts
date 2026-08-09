import { tmpdir } from 'node:os'

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

/**
 * Opt-in proof that the SDK's EXPERIMENTAL usage() control call actually works
 * headless and returns what its types promise — subscription type + plan
 * rate-limit windows — before we build any billing-mode UI on it. Auth comes
 * from this machine's Claude Code login. Gated behind CLAUDE_SMOKE:
 *
 *   npm run smoke:usage
 *
 * The method name literally says DO_NOT_RELY_ON_THIS_API_YET, so this smoke is
 * exactly how we hold it at arm's length: verify against reality, and keep it
 * behind our own capability layer where the churn can't spread.
 */
describe.skipIf(process.env['CLAUDE_SMOKE'] === undefined)('usage() control API (live)', () => {
  it('reports subscription type and plan rate limits', { timeout: 120_000 }, async () => {
    // A streaming input we hold open until usage() answers, so the session
    // (and its control channel) can't close out from under the call.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: 'Reply with just: OK' },
        parent_tool_use_id: null,
        session_id: '',
      }
      await held
    }

    const q = query({ prompt: input(), options: { cwd: tmpdir() } })
    // Drain in the background so the SDK keeps pumping the transport while we
    // await the control response.
    const drained = (async () => {
      for await (const _message of q) {
        void _message
      }
    })()

    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
    release()
    await drained

    console.log('usage():', JSON.stringify(usage, null, 2))

    // The shape we'll normalize into a billing-mode capability.
    expect(usage).toHaveProperty('subscription_type')
    expect(usage).toHaveProperty('rate_limits_available')
    expect(usage.session).toHaveProperty('total_cost_usd')
  })
})
