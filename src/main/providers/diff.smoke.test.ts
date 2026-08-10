import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import type { EventPayloads, EventType } from '../../shared/events'
import { runGit } from '../git'
import { createClaudeProvider } from './claude'
import type { ClaudeQuery } from './claude'

/**
 * Opt-in smoke against REAL Claude that guards the exact gap that shipped once:
 * the adapter must turn a real file edit into a file.diffed event. Without the
 * git-diff wiring this fails — which is the point. Runs Claude in a throwaway
 * git repo so `git diff HEAD` has a baseline. Skipped unless CLAUDE_SMOKE is set:
 *
 *   npm run smoke:diff
 */
describe.skipIf(process.env['CLAUDE_SMOKE'] === undefined)('diff (live smoke)', () => {
  it('renders a real edit as a file.diffed event', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-diff-smoke-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir })
    }
    git('init', '-q')
    git('config', 'user.email', 'smoke@agentinator.test')
    git('config', 'user.name', 'smoke')
    writeFileSync(join(dir, 'greeting.txt'), 'hello\n')
    git('add', '-A')
    git('commit', '-qm', 'init')

    const provider = createClaudeProvider(
      query as unknown as ClaudeQuery,
      undefined,
      undefined,
      runGit,
    )
    const events: Array<{ type: EventType; payload: EventPayloads[EventType] }> = []
    let finish: () => void = () => undefined
    const idled = new Promise<void>((resolve) => {
      finish = resolve
    })

    const handle = provider.startSession(
      {
        sessionId: 'session_diff_smoke',
        workspaceId: 'workspace_smoke',
        agentId: 'agent_smoke',
        title: 'Diff smoke',
        cwd: dir,
        prompt: 'Edit greeting.txt so it reads "hello world" instead of "hello", then reply DONE.',
      },
      (type, payload) => {
        events.push({ type, payload })
        if (type === 'session.idle') {
          finish()
        }
      },
    )
    await idled
    // file.diffed is reported just after the turn — give it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await handle.cancel()

    console.log('normalized events:', events.map((event) => event.type).join(' → '))

    const diffs = events.filter((event) => event.type === 'file.diffed')
    expect(diffs.length).toBeGreaterThan(0)
    expect((diffs[0]?.payload as EventPayloads['file.diffed']).path).toContain('greeting.txt')
  })
})
