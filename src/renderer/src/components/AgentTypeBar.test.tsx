// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentType } from '../../../shared/agentTypes'
import type { AgentinatorBridge } from '../../../shared/bridge'
import { AgentTypesProvider } from '../state/agentTypes'
import { AgentTypeBar } from './AgentTypeBar'

function stub(types: AgentType[] = []): {
  bridge: AgentinatorBridge
  save: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const save = vi.fn(() => Promise.resolve())
  const remove = vi.fn(() => Promise.resolve())
  return {
    save,
    remove,
    bridge: {
      agentTypes: { list: vi.fn(() => Promise.resolve(types)), save, remove },
    } as unknown as AgentinatorBridge,
  }
}

function renderBar(
  types: AgentType[] = [],
  selectedId: string | null = null,
): {
  save: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  onSelect: ReturnType<typeof vi.fn>
} {
  const s = stub(types)
  window.agentinator = s.bridge
  const onSelect = vi.fn()
  render(
    <AgentTypesProvider>
      <AgentTypeBar selectedId={selectedId} onSelect={onSelect} />
    </AgentTypesProvider>,
  )
  return { save: s.save, remove: s.remove, onSelect }
}

afterEach(() => {
  delete window.agentinator
})

describe('AgentTypeBar', () => {
  it('lists saved types in the picker and reports a selection', async () => {
    const { onSelect } = renderBar([{ id: 'r', name: 'Reviewer', instructions: 'x' }])

    const select = screen.getByRole('combobox', { name: 'Agent type' })
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Reviewer' })).toBeInTheDocument()
    })
    fireEvent.change(select, { target: { value: 'r' } })
    expect(onSelect).toHaveBeenCalledWith('r')
    // The default option clears the selection.
    fireEvent.change(select, { target: { value: '' } })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('creates a type via the Manage panel', () => {
    const { save } = renderBar()

    // The manager is hidden until opened.
    expect(screen.queryByRole('textbox', { name: 'Agent type name' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))

    // A blank name doesn't save.
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(save).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Agent type name' }), {
      target: { value: 'Reviewer' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent type instructions' }), {
      target: { value: 'Review only.' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent type model' }), {
      target: { value: 'claude-haiku-4-5' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Read-only role' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Reviewer',
        instructions: 'Review only.',
        model: 'claude-haiku-4-5',
        readOnly: true,
      }),
    )
  })

  it('creates a minimal type with just a name', () => {
    const { save } = renderBar()

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent type name' }), {
      target: { value: 'Scout' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    // No model, no read-only — those keys are omitted, not set to empty/false.
    const saved = save.mock.calls[0][0] as Record<string, unknown>
    expect(saved).toMatchObject({ name: 'Scout', instructions: '' })
    expect(saved).not.toHaveProperty('model')
    expect(saved).not.toHaveProperty('readOnly')
  })

  it('lists types with their posture and deletes them, clearing selection only when needed', async () => {
    const { remove, onSelect } = renderBar(
      [
        { id: 'r', name: 'Reviewer', instructions: 'x', readOnly: true, model: 'm' },
        { id: 't', name: 'Tester', instructions: 'y' },
      ],
      'r',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Reviewer' })).toBeInTheDocument()
    })
    // Reviewer shows its posture in the manager list (Tester, with none, renders
    // just its name — exercised by its Delete button below).
    expect(screen.getByText('Reviewer · read-only · m')).toBeInTheDocument()

    // Deleting a non-selected type leaves the selection alone.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Tester' }))
    expect(remove).toHaveBeenCalledWith('t')
    expect(onSelect).not.toHaveBeenCalled()

    // Deleting the selected type clears it.
    fireEvent.click(screen.getByRole('button', { name: 'Delete Reviewer' }))
    expect(remove).toHaveBeenCalledWith('r')
    expect(onSelect).toHaveBeenCalledWith(null)
  })
})
