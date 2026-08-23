// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentType } from '../../../shared/agentTypes'
import type { AgentinatorBridge } from '../../../shared/bridge'
import type { Skill } from '../../../shared/skills'
import { AgentTypesProvider } from '../state/agentTypes'
import { SkillsProvider } from '../state/skills'
import { AgentTypeBar } from './AgentTypeBar'

interface Spies {
  save: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  saveSkill: ReturnType<typeof vi.fn>
  removeSkill: ReturnType<typeof vi.fn>
}

function renderBar(types: AgentType[] = [], skills: Skill[] = []): Spies {
  const save = vi.fn(() => Promise.resolve())
  const remove = vi.fn(() => Promise.resolve())
  const saveSkill = vi.fn(() => Promise.resolve())
  const removeSkill = vi.fn(() => Promise.resolve())
  window.agentinator = {
    agentTypes: { list: vi.fn(() => Promise.resolve(types)), save, remove },
    skills: { list: vi.fn(() => Promise.resolve(skills)), save: saveSkill, remove: removeSkill },
  } as unknown as AgentinatorBridge
  render(
    <AgentTypesProvider>
      <SkillsProvider>
        <AgentTypeBar />
      </SkillsProvider>
    </AgentTypesProvider>,
  )
  return { save, remove, saveSkill, removeSkill }
}

afterEach(() => {
  delete window.agentinator
})

describe('AgentTypeBar', () => {
  it('has no role picker of its own — roles are assigned on plan tasks', () => {
    renderBar([{ id: 'r', name: 'Reviewer', instructions: 'x' }])

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument()
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

  it('lists types with their posture and deletes them', async () => {
    const { remove } = renderBar([
      {
        id: 'r',
        name: 'Reviewer',
        instructions: 'x',
        readOnly: true,
        model: 'm',
        skillIds: ['s'],
      },
      { id: 't', name: 'Tester', instructions: 'y' },
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Reviewer' })).toBeInTheDocument()
    })
    // Reviewer shows its posture + skill count in the manager list (Tester, with
    // none, renders just its name — exercised by its Delete button below).
    expect(screen.getByText('Reviewer · read-only · m · 1 skill(s)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Tester' }))
    expect(remove).toHaveBeenCalledWith('t')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Reviewer' }))
    expect(remove).toHaveBeenCalledWith('r')
  })

  it('creates a skill and deletes an existing one', async () => {
    const { saveSkill, removeSkill } = renderBar(
      [],
      [
        {
          id: 's1',
          name: 'Commits',
          description: 'commit style',
          body: 'Use conventional commits.',
        },
        { id: 's2', name: 'Bare', description: '', body: 'b' }, // no description → name only
      ],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete skill Commits' })).toBeInTheDocument()
    })

    // A blank skill name doesn't save.
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    expect(saveSkill).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Skill name' }), {
      target: { value: 'Testing' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill description' }), {
      target: { value: 'how we test' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill body' }), {
      target: { value: 'Write vitest tests colocated with source.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    expect(saveSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Testing',
        description: 'how we test',
        body: 'Write vitest tests colocated with source.',
      }),
    )

    // Both existing skills render (with and without a description) and delete.
    fireEvent.click(screen.getByRole('button', { name: 'Delete skill Commits' }))
    expect(removeSkill).toHaveBeenCalledWith('s1')
    expect(screen.getByRole('button', { name: 'Delete skill Bare' })).toBeInTheDocument()
  })

  it('attaches a skill to a new type', async () => {
    const { save } = renderBar([], [{ id: 's1', name: 'Commits', description: 'd', body: 'b' }])

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Attach Commits' })).toBeInTheDocument()
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent type name' }), {
      target: { value: 'Committer' },
    })
    // Toggle on, then off, then on again — the final type carries the skill.
    const attach = screen.getByRole('checkbox', { name: 'Attach Commits' })
    fireEvent.click(attach)
    fireEvent.click(attach)
    fireEvent.click(attach)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Committer', skillIds: ['s1'] }),
    )
  })
})
