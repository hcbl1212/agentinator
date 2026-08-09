import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import type { EventPayloads, EventType } from '../shared/events'
import { EventStore } from './eventStore'
import { createClaudeProvider } from './providers/claude'
import type { ClaudeQuery } from './providers/claude'
import { SessionManager } from './sessions'

/**
 * Opt-in proof that vendor-native resume survives a real process restart — the
 * one critical path the mock e2e can't fake (only real Claude has native
 * resume). It starts a task that plants a fact, then simulates a full restart:
 * cancel the live session, close the on-disk log, reopen it into a brand-new
 * SessionManager with no live handles, and reply. If resume works, the model
 * recalls the fact from before the "restart". Gated behind CLAUDE_SMOKE so CI
 * and normal runs never touch the network:
 *
 *   npm run smoke:resume
 */
describe.skipIf(process.env['CLAUDE_SMOKE'] === undefined)('session resume (live)', () => {
  it(
    'recalls context after a simulated restart via native resume',
    { timeout: 240_000 },
    async () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), 'agentinator-resume-')), 'log.db')
      const claude = (): ClaudeQuery => query as unknown as ClaudeQuery
      // Resolves the first time a turn goes idle (a turn's end, session stays alive).
      const idleOnce = (): { settle: (type: EventType) => void; done: Promise<void> } => {
        let finish: () => void = () => undefined
        const done = new Promise<void>((resolve) => {
          finish = resolve
        })
        return {
          settle: (type) => {
            if (type === 'session.idle') {
              finish()
            }
          },
          done,
        }
      }

      // --- First run: plant a fact, wait for the turn to settle. ---
      const storeA = new EventStore(dbPath)
      const firstTurn = idleOnce()
      const managerA = new SessionManager(storeA, (event) => {
        firstTurn.settle(event.type)
      })
      managerA.register(createClaudeProvider(claude(), () => Promise.resolve(true)))
      const sessionId = managerA.start({
        providerId: 'claude',
        title: 'Resume proof',
        prompt: 'Remember this secret word: BANANA. Reply with just: OK',
        cwd: process.cwd(),
      })
      await firstTurn.done
      // Simulate the app quitting: close the live stream and the on-disk log.
      await managerA.cancel(sessionId)
      storeA.close()

      // --- Restart: a fresh store + manager, no live handles. ---
      const storeB = new EventStore(dbPath)
      const texts: string[] = []
      const secondTurn = idleOnce()
      const managerB = new SessionManager(storeB, (event) => {
        if (event.type === 'agent.text') {
          texts.push((event.payload as EventPayloads['agent.text']).text)
        }
        secondTurn.settle(event.type)
      })
      managerB.register(createClaudeProvider(claude(), () => Promise.resolve(true)))

      await managerB.send(
        sessionId,
        'What was the secret word I told you earlier? Reply with only that word, in uppercase.',
      )
      await secondTurn.done
      await managerB.cancel(sessionId)

      const reply = texts.join('\n')
      console.log('resumed reply:', reply)
      // The log recorded a native resume token and the manager reopened the session.
      expect(storeB.listBySession(sessionId).map((event) => event.type)).toContain(
        'session.resumed',
      )
      expect(reply.toUpperCase()).toContain('BANANA')
      storeB.close()
    },
  )
})
