import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { EventPayloads, StoredEvent } from '../../../shared/events'

export type SessionStatus = 'running' | 'idle'

/** A live agent session as the fleet rail and composer see it. */
export interface SessionInfo {
  id: string
  title: string
  status: SessionStatus
  /** The provider running it (e.g. "claude"), shown per agent in the rail. */
  providerId?: string
}

/**
 * Folds one event into the session list. Sessions appear on start, flip
 * between running/idle as turns come and go, and drop off when they end — so
 * the list is always the set of live agents, newest last.
 */
export function reduceSession(sessions: SessionInfo[], event: StoredEvent): SessionInfo[] {
  const withStatus = (id: string, status: SessionStatus): SessionInfo[] =>
    sessions.map((session) => (session.id === id ? { ...session, status } : session))
  switch (event.type) {
    case 'session.started': {
      const payload = event.payload as EventPayloads['session.started']
      return sessions.some((session) => session.id === payload.sessionId)
        ? sessions
        : [
            ...sessions,
            {
              id: payload.sessionId,
              title: payload.title,
              status: 'running',
              providerId: payload.providerId,
            },
          ]
    }
    case 'user.message': {
      // A new message means the agent is working again.
      return withStatus((event.payload as EventPayloads['user.message']).sessionId, 'running')
    }
    case 'session.idle': {
      return withStatus((event.payload as EventPayloads['session.idle']).sessionId, 'idle')
    }
    case 'session.ended': {
      const payload = event.payload as EventPayloads['session.ended']
      return sessions.filter((session) => session.id !== payload.sessionId)
    }
    default:
      return sessions
  }
}

interface SessionsState {
  sessions: SessionInfo[]
}

const SessionsContext = createContext<SessionsState | null>(null)

/** Derives the live agent list from the append-only log and shares it. */
export function SessionsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.tail(500).then((page) => {
      // Fold history onto whatever live events already arrived (don't rebuild
      // from empty, or a slow tail would wipe events that raced ahead of it).
      if (!cancelled) {
        setSessions((previous) => page.reduce(reduceSession, previous))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setSessions((previous) => reduceSession(previous, event))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo(() => ({ sessions }), [sessions])
  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
}

export function useSessions(): SessionsState {
  const state = useContext(SessionsContext)
  if (state === null) {
    throw new Error('useSessions must be used within a SessionsProvider')
  }
  return state
}
