import { describe, expect, it, vi } from 'vitest'

import type { EventPayloads, EventType, StoredEvent } from '../shared/events'
import { AttentionTracker } from './attention'

function event<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq: 1, ts: 't', type, payload }
}

const approval = (sessionId: string, requestId: string, tool = 'Bash'): StoredEvent =>
  event('approval.requested', { sessionId, requestId, tool, input: {} })
const question = (sessionId: string, requestId: string, q?: string): StoredEvent =>
  event('agent.question', {
    sessionId,
    requestId,
    questions: q === undefined ? [] : [{ question: q, options: ['a'] }],
  })

function setup(): {
  tracker: AttentionTracker
  notify: ReturnType<typeof vi.fn>
  setBadge: ReturnType<typeof vi.fn>
} {
  const notify = vi.fn()
  const setBadge = vi.fn()
  return { tracker: new AttentionTracker({ notify, setBadge }), notify, setBadge }
}

describe('AttentionTracker', () => {
  it('notifies and badges when an approval is requested, deduping repeats', () => {
    const { tracker, notify, setBadge } = setup()

    tracker.observe(approval('s1', 'r1', 'Write'))
    tracker.observe(approval('s1', 'r1', 'Write')) // dupe — no second notification

    expect(notify).toHaveBeenCalledExactlyOnceWith('Approval needed', 'An agent wants to run Write')
    expect(setBadge).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('notifies for a question (with a fallback body) and clears it on reply', () => {
    const { tracker, notify, setBadge } = setup()

    tracker.observe(question('s1', 'q1')) // no text → generic body
    expect(notify).toHaveBeenCalledWith('Agent has a question', 'An agent needs a decision')
    expect(setBadge).toHaveBeenLastCalledWith(1)

    tracker.observe(event('user.message', { sessionId: 's1', text: 'answer' }))
    expect(setBadge).toHaveBeenLastCalledWith(0)
  })

  it('replying clears only the question, leaving a pending approval', () => {
    const { tracker, setBadge } = setup()
    tracker.observe(approval('s1', 'r1'))
    tracker.observe(question('s1', 'q1', 'Pick'))
    expect(setBadge).toHaveBeenLastCalledWith(2)

    tracker.observe(event('user.message', { sessionId: 's1', text: 'hi' }))
    expect(setBadge).toHaveBeenLastCalledWith(1) // the approval survives
  })

  it('clears an approval when it resolves', () => {
    const { tracker, setBadge } = setup()

    tracker.observe(approval('s1', 'r1'))
    tracker.observe(
      event('approval.resolved', { sessionId: 's1', requestId: 'r1', approved: true, via: 'user' }),
    )

    expect(setBadge).toHaveBeenLastCalledWith(0)
    // Resolving something unknown doesn't re-badge.
    setBadge.mockClear()
    tracker.observe(
      event('approval.resolved', {
        sessionId: 's1',
        requestId: 'gone',
        approved: false,
        via: 'user',
      }),
    )
    expect(setBadge).not.toHaveBeenCalled()
  })

  it('drops all of a session’s items when it ends, notifying on failure', () => {
    const { tracker, notify, setBadge } = setup()
    tracker.observe(approval('s1', 'r1'))
    tracker.observe(question('s1', 'q1', 'Pick'))
    expect(setBadge).toHaveBeenLastCalledWith(2)

    tracker.observe(event('session.ended', { sessionId: 's1', outcome: 'failed' }))

    expect(setBadge).toHaveBeenLastCalledWith(0)
    expect(notify).toHaveBeenCalledWith('Agent failed', 'A task ended with an error')
  })

  it('does not notify when a session ends cleanly, and ignores unrelated events', () => {
    const { tracker, notify, setBadge } = setup()
    tracker.observe(approval('s1', 'r1'))
    notify.mockClear()
    setBadge.mockClear()

    // A clean end with a live item clears it (badge) but does not notify.
    tracker.observe(event('session.ended', { sessionId: 's1', outcome: 'completed' }))
    expect(setBadge).toHaveBeenCalledWith(0)
    expect(notify).not.toHaveBeenCalled()

    // An end for a session with nothing open changes nothing.
    setBadge.mockClear()
    tracker.observe(event('session.ended', { sessionId: 'other', outcome: 'completed' }))
    tracker.observe(event('agent.text', { sessionId: 's1', text: 'noise' }))
    expect(setBadge).not.toHaveBeenCalled()
  })
})
