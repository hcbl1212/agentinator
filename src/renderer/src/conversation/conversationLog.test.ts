import { describe, expect, it } from 'vitest'

import type { StoredEvent } from '../../../shared/events'
import { isConversationEvent } from './conversationLog'

function event(type: StoredEvent['type']): StoredEvent {
  return { seq: 1, ts: 't', type, payload: {} } as StoredEvent
}

describe('isConversationEvent', () => {
  it('includes the dialogue and the terse action trail', () => {
    for (const type of [
      'session.started',
      'user.message',
      'agent.text',
      'agent.thinking',
      'tool.called',
      'tool.resulted',
      'file.diffed',
      'session.idle',
      'session.ended',
      'approval.resolved',
      'budget.exceeded',
    ] as const) {
      expect(isConversationEvent(event(type))).toBe(true)
    }
  })

  it('excludes decisions (they render as cards) and pure noise', () => {
    for (const type of [
      'agent.question',
      'approval.requested',
      'app.started',
      'cost.usage',
    ] as const) {
      expect(isConversationEvent(event(type))).toBe(false)
    }
  })
})
