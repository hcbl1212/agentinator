import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { AgentType } from '../../../shared/agentTypes'

interface AgentTypesState {
  types: AgentType[]
  /** Create or update a type, then refresh the list. */
  save(type: AgentType): Promise<void>
  /** Delete a type by id, then refresh the list. */
  remove(id: string): Promise<void>
}

const AgentTypesContext = createContext<AgentTypesState | null>(null)

/**
 * The saved agent-type presets. Unlike most state these aren't event-sourced —
 * they're user settings — so the provider loads them once and re-reads after a
 * save/remove rather than reducing a live stream.
 */
export function AgentTypesProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [types, setTypes] = useState<AgentType[]>([])

  const reload = useCallback(async (): Promise<void> => {
    const bridge = window.agentinator
    if (bridge !== undefined) {
      setTypes(await bridge.agentTypes.list())
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const value = useMemo<AgentTypesState>(
    () => ({
      types,
      save: async (type) => {
        await window.agentinator?.agentTypes.save(type)
        await reload()
      },
      remove: async (id) => {
        await window.agentinator?.agentTypes.remove(id)
        await reload()
      },
    }),
    [types, reload],
  )

  return <AgentTypesContext.Provider value={value}>{children}</AgentTypesContext.Provider>
}

export function useAgentTypes(): AgentTypesState {
  const state = useContext(AgentTypesContext)
  if (state === null) {
    throw new Error('useAgentTypes must be used within an AgentTypesProvider')
  }
  return state
}
