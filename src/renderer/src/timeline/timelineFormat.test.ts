import { describe, expect, it } from 'vitest'

import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { describeEvent, mergeBySeq } from './timelineFormat'

function stored<T extends EventType>(type: T, payload: EventPayloads[T], seq = 1): StoredEvent {
  return { seq, ts: '2026-08-08T00:00:00.000Z', type, payload } as StoredEvent
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
