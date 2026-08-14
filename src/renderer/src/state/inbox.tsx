import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { EventPayloads, StoredEvent } from '../../../shared/events'

/** Something an agent is blocked on you for: a permission decision or an
 * answer to a question. The triage queue is the set of these still open. */
export interface InboxItem {
  id: string
  sessionId: string
  kind: 'approval' | 'question'
  detail: string
}

/**
 * Folds one event into the attention inbox: an item appears when an agent needs
 * you (a pending approval, or a question) and clears when you handle it (the
 * approval resolves, you reply, or the session ends).
 */
export function reduceInbox(items: InboxItem[], event: StoredEvent): InboxItem[] {
  const without = (id: string): InboxItem[] => items.filter((item) => item.id !== id)
  switch (event.type) {
    case 'approval.requested': {
      const payload = event.payload as EventPayloads['approval.requested']
      const id = `a:${payload.requestId}`
      return items.some((item) => item.id === id)
        ? items
        : [...items, { id, sessionId: payload.sessionId, kind: 'approval', detail: payload.tool }]
    }
    case 'approval.resolved': {
      return without(`a:${(event.payload as EventPayloads['approval.resolved']).requestId}`)
    }
    case 'agent.question': {
      const payload = event.payload as EventPayloads['agent.question']
      const id = `q:${payload.requestId}`
      return items.some((item) => item.id === id)
        ? items
        : [
            ...items,
            {
              id,
              sessionId: payload.sessionId,
              kind: 'question',
              detail: payload.questions[0]?.question ?? 'a question',
            },
          ]
    }
    case 'user.message': {
      // Replying to an agent answers whatever it asked.
      const { sessionId } = event.payload as EventPayloads['user.message']
      return items.filter((item) => !(item.kind === 'question' && item.sessionId === sessionId))
    }
    case 'session.ended': {
      // A gone agent needs nothing.
      const { sessionId } = event.payload as EventPayloads['session.ended']
      return items.filter((item) => item.sessionId !== sessionId)
    }
    default:
      return items
  }
}

interface InboxState {
  items: InboxItem[]
}

const InboxContext = createContext<InboxState | null>(null)

/** Derives the attention inbox from the append-only log and shares it. */
export function InboxProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<InboxItem[]>([])

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.tail(500).then((page) => {
      if (!cancelled) {
        setItems((previous) => page.reduce(reduceInbox, previous))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setItems((previous) => reduceInbox(previous, event))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo(() => ({ items }), [items])
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}

export function useInbox(): InboxState {
  const state = useContext(InboxContext)
  if (state === null) {
    throw new Error('useInbox must be used within an InboxProvider')
  }
  return state
}
