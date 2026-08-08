// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SelectionProvider, useSelection } from './selection'

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <SelectionProvider>{children}</SelectionProvider>
}

describe('selection context', () => {
  it('starts with nothing selected', () => {
    const { result } = renderHook(() => useSelection(), { wrapper })

    expect(result.current.selection).toBeNull()
  })

  it('selects an entity and clears it again', () => {
    const { result } = renderHook(() => useSelection(), { wrapper })

    act(() => {
      result.current.select({ kind: 'session', id: 'session_1' })
    })
    expect(result.current.selection).toEqual({ kind: 'session', id: 'session_1' })

    act(() => {
      result.current.clear()
    })
    expect(result.current.selection).toBeNull()
  })

  it('throws when used outside its provider', () => {
    expect(() => renderHook(() => useSelection())).toThrow(
      'useSelection must be used within a SelectionProvider',
    )
  })
})
