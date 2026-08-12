import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { EventPayloads, StoredEvent } from '../../../shared/events'

/** A task parked in the backlog, awaiting dispatch to an agent. */
export interface QueuedTask {
  id: string
  prompt: string
}

/**
 * Folds one event into the pending backlog: a task appears when queued and
 * leaves when dispatched (it becomes an agent) or removed. Order is insertion
 * order — the log's natural sequence.
 */
export function reduceQueue(tasks: QueuedTask[], event: StoredEvent): QueuedTask[] {
  switch (event.type) {
    case 'task.queued': {
      const payload = event.payload as EventPayloads['task.queued']
      return tasks.some((task) => task.id === payload.taskId)
        ? tasks
        : [...tasks, { id: payload.taskId, prompt: payload.prompt }]
    }
    case 'task.dispatched': {
      const { taskId } = event.payload as EventPayloads['task.dispatched']
      return tasks.filter((task) => task.id !== taskId)
    }
    case 'task.removed': {
      const { taskId } = event.payload as EventPayloads['task.removed']
      return tasks.filter((task) => task.id !== taskId)
    }
    default:
      return tasks
  }
}

interface QueueState {
  tasks: QueuedTask[]
}

const QueueContext = createContext<QueueState | null>(null)

/** Derives the pending task backlog from the append-only log and shares it. */
export function QueueProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [tasks, setTasks] = useState<QueuedTask[]>([])

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void bridge.events.tail(500).then((page) => {
      if (!cancelled) {
        setTasks((previous) => page.reduce(reduceQueue, previous))
      }
    })
    const unsubscribe = bridge.events.onAppended((event) => {
      setTasks((previous) => reduceQueue(previous, event))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo(() => ({ tasks }), [tasks])
  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>
}

export function useQueue(): QueueState {
  const state = useContext(QueueContext)
  if (state === null) {
    throw new Error('useQueue must be used within a QueueProvider')
  }
  return state
}
