import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { Skill } from '../../../shared/skills'

interface SkillsState {
  skills: Skill[]
  /** Create or update a skill, then refresh the list. */
  save(skill: Skill): Promise<void>
  /** Delete a skill by id, then refresh the list. */
  remove(id: string): Promise<void>
}

const SkillsContext = createContext<SkillsState | null>(null)

/**
 * The saved skills (reusable instruction packages). Like agent types these are
 * user settings, not event-sourced — loaded once and re-read after a change.
 */
export function SkillsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([])

  const reload = useCallback(async (): Promise<void> => {
    const bridge = window.agentinator
    if (bridge !== undefined) {
      setSkills(await bridge.skills.list())
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const value = useMemo<SkillsState>(
    () => ({
      skills,
      save: async (skill) => {
        await window.agentinator?.skills.save(skill)
        await reload()
      },
      remove: async (id) => {
        await window.agentinator?.skills.remove(id)
        await reload()
      },
    }),
    [skills, reload],
  )

  return <SkillsContext.Provider value={value}>{children}</SkillsContext.Provider>
}

export function useSkills(): SkillsState {
  const state = useContext(SkillsContext)
  if (state === null) {
    throw new Error('useSkills must be used within a SkillsProvider')
  }
  return state
}
