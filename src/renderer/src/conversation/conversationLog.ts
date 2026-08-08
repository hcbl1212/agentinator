import type { EventType, StoredEvent } from '../../../shared/events'

/**
 * The event types that belong in the conversation console — the readable
 * dialogue plus the terse trail of what the agent did. Decisions
 * (agent.question, approval.requested) are deliberately excluded: they render
 * as interactive cards, not log lines. Pure noise for this surface
 * (app.started, cost.usage) stays in the status bar and the full Timeline.
 */
const CONVERSATION_TYPES = new Set<EventType>([
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
])

/** Whether an event shows as a line in the conversation console. */
export function isConversationEvent(event: StoredEvent): boolean {
  return CONVERSATION_TYPES.has(event.type)
}
