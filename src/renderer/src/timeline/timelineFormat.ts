import type { EventPayloads, StoredEvent } from '../../../shared/events'

/**
 * Turns stored events into readable timeline lines. Tones map to CSS classes
 * (cockpit design system); markers are plain text, no icon fonts.
 */
export type Tone = 'accent' | 'ink' | 'soft' | 'faint' | 'ok' | 'err'

export interface TimelineLine {
  marker: string
  text: string
  tone: Tone
}

function compactInput(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>
    if (typeof record['command'] === 'string') {
      return record['command']
    }
    if (typeof record['path'] === 'string') {
      return record['path']
    }
  }
  const serialized = JSON.stringify(input)
  return serialized.length > 60 ? `${serialized.slice(0, 57)}…` : serialized
}

export function describeEvent(event: StoredEvent): TimelineLine {
  switch (event.type) {
    case 'app.started': {
      const payload = event.payload as EventPayloads['app.started']
      return { marker: '·', text: `app started v${payload.version}`, tone: 'faint' }
    }
    case 'session.started': {
      const payload = event.payload as EventPayloads['session.started']
      return { marker: '▶', text: `session started · ${payload.title}`, tone: 'accent' }
    }
    case 'session.ended': {
      const payload = event.payload as EventPayloads['session.ended']
      return {
        marker: '■',
        text: `session ${payload.outcome}`,
        tone: payload.outcome === 'completed' ? 'ok' : 'err',
      }
    }
    case 'agent.text': {
      const payload = event.payload as EventPayloads['agent.text']
      return { marker: '', text: payload.text, tone: 'ink' }
    }
    case 'agent.thinking': {
      const payload = event.payload as EventPayloads['agent.thinking']
      return { marker: '…', text: `thinking · ${payload.summary}`, tone: 'soft' }
    }
    case 'tool.called': {
      const payload = event.payload as EventPayloads['tool.called']
      return { marker: '▸', text: `${payload.tool} ${compactInput(payload.input)}`, tone: 'soft' }
    }
    case 'tool.resulted': {
      const payload = event.payload as EventPayloads['tool.resulted']
      return {
        marker: payload.ok ? '✓' : '✗',
        text: payload.output,
        tone: payload.ok ? 'ok' : 'err',
      }
    }
    case 'file.diffed': {
      const payload = event.payload as EventPayloads['file.diffed']
      return {
        marker: '±',
        text: `${payload.path} +${payload.additions} −${payload.deletions}`,
        tone: 'ink',
      }
    }
    case 'cost.usage': {
      const payload = event.payload as EventPayloads['cost.usage']
      return {
        marker: '$',
        text: `${payload.inputTokens} in / ${payload.outputTokens} out · cache ${payload.cacheReadInputTokens} · $${payload.usd.toFixed(4)}`,
        tone: 'faint',
      }
    }
  }
  // Unknown event types from newer logs render inert instead of crashing —
  // reducers must tolerate what they don't understand (event-fabric rule).
  return { marker: '·', text: String(event.type), tone: 'faint' }
}

/** Merge two seq-ordered slices of the log, deduplicating by seq. */
export function mergeBySeq(base: StoredEvent[], extra: StoredEvent[]): StoredEvent[] {
  const seen = new Map<number, StoredEvent>()
  for (const event of [...base, ...extra]) {
    seen.set(event.seq, event)
  }
  return [...seen.values()].sort((a, b) => a.seq - b.seq)
}
