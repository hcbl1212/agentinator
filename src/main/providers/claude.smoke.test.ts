import { tmpdir } from 'node:os'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import type { EventPayloads, EventType } from '../../shared/events'
import { createClaudeProvider } from './claude'
import type { ClaudeQuery } from './claude'

/**
 * Opt-in smoke test against REAL Claude, authenticated with whatever this
 * machine's Claude Code login provides (a claude.ai subscription works — no
 * API key required). Skipped unless CLAUDE_SMOKE is set, so CI and normal
 * test runs never make a network call:
 *
 *   npm run smoke:claude
 */
describe.skipIf(process.env['CLAUDE_SMOKE'] === undefined)('claude provider (live smoke)', () => {
  it('runs a real session end to end through the adapter', { timeout: 180_000 }, async () => {
    const provider = createClaudeProvider(query as unknown as ClaudeQuery)
    const events: Array<{ type: EventType; payload: EventPayloads[EventType] }> = []

    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })

    provider.startSession(
      {
        sessionId: 'session_smoke',
        workspaceId: 'workspace_smoke',
        agentId: 'agent_smoke',
        title: 'Live smoke test',
        prompt: 'Reply with exactly this string and nothing else: AGENTINATOR_OK',
        cwd: tmpdir(),
      },
      (type, payload) => {
        events.push({ type, payload })
        if (type === 'session.ended') {
          finish()
        }
      },
    )
    await done

    const texts = events
      .filter((event) => event.type === 'agent.text')
      .map((event) => (event.payload as EventPayloads['agent.text']).text)
      .join('\n')
    const ended = events.at(-1)?.payload as EventPayloads['session.ended']

    console.log('normalized events:', events.map((event) => event.type).join(' → '))

    expect(texts).toContain('AGENTINATOR_OK')
    expect(ended.outcome).toBe('completed')
    expect(events.some((event) => event.type === 'cost.usage')).toBe(true)
  })
})
