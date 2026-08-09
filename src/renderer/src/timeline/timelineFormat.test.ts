import { describe, expect, it } from 'vitest'

import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { describeEvent, matchesQuery, mergeBySeq } from './timelineFormat'

function stored<T extends EventType>(type: T, payload: EventPayloads[T], seq = 1): StoredEvent {
  return { seq, ts: '2026-08-08T00:00:00.000Z', type, payload }
}

describe('describeEvent', () => {
  it('renders app.started as a faint marker line', () => {
    expect(describeEvent(stored('app.started', { version: '0.1.0' }))).toEqual({
      marker: '·',
      text: 'app started v0.1.0',
      tone: 'faint',
    })
  })

  it('renders session boundaries with outcome tones', () => {
    expect(
      describeEvent(
        stored('session.started', {
          sessionId: 's',
          agentId: 'a',
          workspaceId: 'w',
          title: 'Demo',
        }),
      ),
    ).toMatchObject({ marker: '▶', text: 'session started · Demo', tone: 'accent' })
    expect(
      describeEvent(stored('session.ended', { sessionId: 's', outcome: 'completed' })),
    ).toMatchObject({ text: 'session completed', tone: 'ok' })
    expect(
      describeEvent(stored('session.ended', { sessionId: 's', outcome: 'failed' })),
    ).toMatchObject({ tone: 'err' })
  })

  it('renders agent text plainly and thinking softly', () => {
    expect(describeEvent(stored('agent.text', { sessionId: 's', text: 'On it.' }))).toMatchObject({
      text: 'On it.',
      tone: 'ink',
    })
    expect(
      describeEvent(stored('agent.thinking', { sessionId: 's', summary: 'Planning.' })),
    ).toMatchObject({ text: 'thinking · Planning.', tone: 'soft' })
  })

  it('renders agent questions and user replies', () => {
    expect(
      describeEvent(
        stored('agent.question', {
          sessionId: 's',
          requestId: 'approval_q',
          questions: [{ question: 'Which approach?', options: ['a', 'b'] }],
        }),
      ),
    ).toMatchObject({ text: 'asking · Which approach?', tone: 'warn' })
    // An empty question set still renders without crashing.
    expect(
      describeEvent(
        stored('agent.question', { sessionId: 's', requestId: 'approval_q', questions: [] }),
      ),
    ).toMatchObject({ text: 'asking · a question' })
    expect(
      describeEvent(stored('user.message', { sessionId: 's', text: 'keep going' })),
    ).toMatchObject({ marker: '›', text: 'keep going', tone: 'accent' })
    // Attached screenshots surface as a count suffix (singular / plural).
    expect(
      describeEvent(stored('user.message', { sessionId: 's', text: 'this', imageCount: 1 })),
    ).toMatchObject({ text: 'this [+1 image]' })
    expect(
      describeEvent(stored('user.message', { sessionId: 's', text: 'these', imageCount: 2 })),
    ).toMatchObject({ text: 'these [+2 images]' })
    expect(describeEvent(stored('session.resumed', { sessionId: 's' }))).toMatchObject({
      marker: '↻',
      text: 'session resumed',
      tone: 'accent',
    })
    expect(describeEvent(stored('session.auth', { sessionId: 's', source: 'none' }))).toMatchObject(
      { text: 'on subscription', tone: 'soft' },
    )
    expect(describeEvent(stored('session.auth', { sessionId: 's', source: 'user' }))).toMatchObject(
      { text: 'on API key (metered)', tone: 'accent' },
    )
  })

  it('compacts tool inputs: command, path, then truncated JSON', () => {
    expect(
      describeEvent(
        stored('tool.called', {
          sessionId: 's',
          callId: 'c1',
          tool: 'bash',
          input: { command: 'npm test' },
        }),
      ),
    ).toMatchObject({ marker: '▸', text: 'bash npm test' })
    expect(
      describeEvent(
        stored('tool.called', {
          sessionId: 's',
          callId: 'c2',
          tool: 'write',
          input: { path: 'src/a.ts' },
        }),
      ),
    ).toMatchObject({ text: 'write src/a.ts' })
    expect(
      describeEvent(
        stored('tool.called', { sessionId: 's', callId: 'c3', tool: 'search', input: { q: 'x' } }),
      ),
    ).toMatchObject({ text: 'search {"q":"x"}' })

    const long = describeEvent(
      stored('tool.called', {
        sessionId: 's',
        callId: 'c4',
        tool: 'search',
        input: { q: 'y'.repeat(80) },
      }),
    )
    expect(long.text.endsWith('…')).toBe(true)
    expect(long.text.length).toBeLessThan(70)
  })

  it('serializes non-object and null tool inputs directly', () => {
    expect(
      describeEvent(
        stored('tool.called', { sessionId: 's', callId: 'c5', tool: 'read', input: 'raw' }),
      ),
    ).toMatchObject({ text: 'read "raw"' })
    expect(
      describeEvent(
        stored('tool.called', { sessionId: 's', callId: 'c6', tool: 'grep', input: null }),
      ),
    ).toMatchObject({ text: 'grep null' })
  })

  it('renders tool results with ok/err markers', () => {
    expect(
      describeEvent(
        stored('tool.resulted', { sessionId: 's', callId: 'c', ok: true, output: 'done' }),
      ),
    ).toMatchObject({ marker: '✓', tone: 'ok' })
    expect(
      describeEvent(
        stored('tool.resulted', { sessionId: 's', callId: 'c', ok: false, output: 'boom' }),
      ),
    ).toMatchObject({ marker: '✗', tone: 'err' })
  })

  it('renders diffs and cost summaries', () => {
    expect(
      describeEvent(
        stored('file.diffed', {
          sessionId: 's',
          path: 'src/a.ts',
          additions: 3,
          deletions: 1,
          patch: '+x',
        }),
      ),
    ).toMatchObject({ marker: '±', text: 'src/a.ts +3 −1' })
    expect(
      describeEvent(
        stored('cost.usage', {
          sessionId: 's',
          inputTokens: 1200,
          outputTokens: 340,
          cacheReadInputTokens: 900,
          usd: 0.0042,
        }),
      ),
    ).toMatchObject({ marker: '$', text: '1200 in / 340 out · cache 900 · $0.0042', tone: 'faint' })
  })

  it('renders approvals with warn/ok/err tones and the deciding channel', () => {
    expect(
      describeEvent(
        stored('approval.requested', {
          sessionId: 's',
          requestId: 'approval_1',
          tool: 'bash',
          input: { command: 'npm install left-pad' },
        }),
      ),
    ).toMatchObject({
      marker: '?',
      text: 'approval requested · bash npm install left-pad',
      tone: 'warn',
    })
    expect(
      describeEvent(
        stored('approval.resolved', {
          sessionId: 's',
          requestId: 'approval_1',
          approved: true,
          via: 'allowlist',
        }),
      ),
    ).toMatchObject({ marker: '✓', text: 'approval granted · via allowlist', tone: 'ok' })
    expect(
      describeEvent(
        stored('approval.resolved', {
          sessionId: 's',
          requestId: 'approval_1',
          approved: false,
          via: 'user',
        }),
      ),
    ).toMatchObject({ marker: '✗', text: 'approval denied · via user', tone: 'err' })
  })

  it('renders budget breaches loudly with their scope', () => {
    expect(
      describeEvent(
        stored('budget.exceeded', { sessionId: 's', scope: 'day', usedUsd: 6.004, capUsd: 5 }),
      ),
    ).toMatchObject({
      marker: '!',
      text: 'day budget exceeded · $6.00 of $5.00 — session stopped',
      tone: 'err',
    })
  })

  it('renders unknown event types from newer logs inert instead of crashing', () => {
    const future = {
      seq: 1,
      ts: 't',
      type: 'holograms.rendered',
      payload: {},
    } as unknown as StoredEvent

    expect(describeEvent(future)).toEqual({
      marker: '·',
      text: 'holograms.rendered',
      tone: 'faint',
    })
  })
})

describe('matchesQuery', () => {
  it('matches on event type and on payload content, case-insensitively', () => {
    const event = stored('agent.text', { sessionId: 's', text: 'Adding the greet util' })

    expect(matchesQuery(event, 'GREET')).toBe(true)
    expect(matchesQuery(event, 'agent.text')).toBe(true)
    expect(matchesQuery(event, 'nothing-here')).toBe(false)
  })
})

describe('mergeBySeq', () => {
  it('merges, dedupes by seq, and sorts', () => {
    const a = stored('agent.text', { sessionId: 's', text: 'one' }, 1)
    const b = stored('agent.text', { sessionId: 's', text: 'two' }, 2)
    const c = stored('agent.text', { sessionId: 's', text: 'three' }, 3)

    expect(mergeBySeq([b, a], [b, c])).toEqual([a, b, c])
  })

  it('handles empty inputs', () => {
    expect(mergeBySeq([], [])).toEqual([])
  })
})
