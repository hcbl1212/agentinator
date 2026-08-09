import { describe, expect, it, vi } from 'vitest'

import { createE2eProvider } from './e2e'
import type { EmitEvent, SessionContext } from './types'

function ctx(prompt: string): SessionContext {
  return { sessionId: 's1', workspaceId: 'w', agentId: 'a', title: 'A task', prompt, cwd: '/tmp' }
}

/** Flush the run loop's microtasks (and any pending decide). */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function collector(): { emit: EmitEvent; types: () => string[]; find: (t: string) => unknown } {
  const events: { type: string; payload: unknown }[] = []
  const emit: EmitEvent = (type, payload) => {
    events.push({ type, payload })
  }
  return {
    emit,
    types: () => events.map((event) => event.type),
    find: (type) => events.find((event) => event.type === type)?.payload,
  }
}

describe('createE2eProvider', () => {
  it('streams a diff and cost then goes idle for a plain task', async () => {
    const decide = vi.fn((): Promise<boolean> => Promise.resolve(true))
    const { emit, types, find } = collector()

    createE2eProvider(decide).startSession(ctx('do the thing'), emit)
    await flush()

    expect(types()).toEqual([
      'session.started',
      'agent.text',
      'file.diffed',
      'cost.usage',
      'session.idle',
    ])
    expect(find('file.diffed')).toMatchObject({ path: 'src/demo/e2e.ts', additions: 2 })
    expect(decide).not.toHaveBeenCalled()
  })

  it('requests a write approval when the prompt asks, and reports approval', async () => {
    const decide = vi.fn((): Promise<boolean> => Promise.resolve(true))
    const { emit, find } = collector()

    createE2eProvider(decide).startSession(ctx('needs approval'), emit)
    await flush()

    expect(decide).toHaveBeenCalledWith('s1', 'write', { path: 'src/demo/danger.ts' })
    expect(find('agent.text')).toMatchObject({ text: 'Ready.' })
    // The last agent.text carries the outcome.
    expect(find('session.idle')).toBeDefined()
  })

  it('reports a denied write', async () => {
    const decide = vi.fn((): Promise<boolean> => Promise.resolve(false))
    const events: string[] = []
    const emit: EmitEvent = (type, payload) => {
      if (type === 'agent.text') {
        events.push((payload as { text: string }).text)
      }
    }

    createE2eProvider(decide).startSession(ctx('approval please'), emit)
    await flush()

    expect(events).toContain('Write denied.')
  })

  it('echoes follow-ups and goes idle', () => {
    const decide = vi.fn((): Promise<boolean> => Promise.resolve(true))
    const { emit, types, find } = collector()

    const handle = createE2eProvider(decide).startSession(ctx('hi'), emit)
    void handle.send('ping')

    expect(types()).toContain('session.idle')
    expect(find('agent.text')).toMatchObject({ text: 'Echo: ping' })
  })

  it('cancel ends the session and stops before it idles', async () => {
    const decide = vi.fn((): Promise<boolean> => Promise.resolve(true))
    const { emit, types, find } = collector()

    const handle = createE2eProvider(decide).startSession(ctx('work'), emit)
    void handle.cancel()
    await flush()

    expect(find('session.ended')).toMatchObject({ outcome: 'cancelled' })
    expect(types()).not.toContain('session.idle')
  })

  it('cancel mid-approval stops before reporting the outcome', async () => {
    let resolveDecide: (value: boolean) => void = () => undefined
    const decide = vi.fn(
      (): Promise<boolean> =>
        new Promise((resolve) => {
          resolveDecide = resolve
        }),
    )
    const events: string[] = []
    const emit: EmitEvent = (type, payload) => {
      events.push(type === 'agent.text' ? (payload as { text: string }).text : type)
    }

    const handle = createE2eProvider(decide).startSession(ctx('approval now'), emit)
    await flush() // reaches the pending decide
    void handle.cancel()
    resolveDecide(true)
    await flush()

    expect(events).toContain('session.ended')
    expect(events).not.toContain('Write approved.')
    expect(events).not.toContain('session.idle')
  })
})
