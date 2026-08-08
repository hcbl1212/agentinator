import { createContext, useContext, useMemo, useState } from 'react'

import type { EntityKind } from '../../../shared/events'

/**
 * The one global selection context. Panes subscribe to it and react
 * (focus-follows); none keeps a private notion of "current thing".
 */
export interface Selection {
  kind: EntityKind
  id: string
}

export interface SelectionState {
  selection: Selection | null
  select(next: Selection): void
  clear(): void
}

const SelectionContext = createContext<SelectionState | null>(null)

export function SelectionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [selection, setSelection] = useState<Selection | null>(null)

  const value = useMemo<SelectionState>(
    () => ({
      selection,
      select: (next) => setSelection(next),
      clear: () => setSelection(null),
    }),
    [selection],
  )

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export function useSelection(): SelectionState {
  const state = useContext(SelectionContext)
  if (state === null) {
    throw new Error('useSelection must be used within a SelectionProvider')
  }
  return state
}
