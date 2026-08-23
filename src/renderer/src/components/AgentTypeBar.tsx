import { useState } from 'react'

import { useAgentTypes } from '../state/agentTypes'
import { useSkills } from '../state/skills'

/**
 * Picks the agent-type preset a new task launches under, and manages the set.
 * "Default agent" is the base behaviour; other options apply a role's
 * instructions, model, read-only posture, and attached skills. The Manage panel
 * creates/deletes types and skills inline and attaches skills to a new type.
 */
export function AgentTypeBar({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  const { types, save, remove } = useAgentTypes()
  const { skills, save: saveSkill, remove: removeSkill } = useSkills()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [model, setModel] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [skillName, setSkillName] = useState('')
  const [skillDescription, setSkillDescription] = useState('')
  const [skillBody, setSkillBody] = useState('')

  const toggleSkill = (id: string): void => {
    setSkillIds((was) => (was.includes(id) ? was.filter((s) => s !== id) : [...was, id]))
  }

  const add = (): void => {
    const trimmed = name.trim()
    if (trimmed === '') {
      return
    }
    void save({
      id: `type_${crypto.randomUUID()}`,
      name: trimmed,
      instructions: instructions.trim(),
      ...(model.trim() === '' ? {} : { model: model.trim() }),
      ...(readOnly ? { readOnly: true } : {}),
      ...(skillIds.length === 0 ? {} : { skillIds }),
    })
    setName('')
    setInstructions('')
    setModel('')
    setReadOnly(false)
    setSkillIds([])
  }

  const addSkill = (): void => {
    const trimmed = skillName.trim()
    if (trimmed === '') {
      return
    }
    void saveSkill({
      id: `skill_${crypto.randomUUID()}`,
      name: trimmed,
      description: skillDescription.trim(),
      body: skillBody.trim(),
    })
    setSkillName('')
    setSkillDescription('')
    setSkillBody('')
  }

  return (
    <div className="agent-types">
      <label className="agent-type-pick">
        <span className="agent-type-label">Type</span>
        <select
          className="agent-type-select"
          value={selectedId ?? ''}
          onChange={(event) => onSelect(event.target.value === '' ? null : event.target.value)}
          aria-label="Agent type"
        >
          <option value="">Default agent</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="agent-type-manage"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          Manage
        </button>
      </label>
      {open && (
        <div className="agent-type-manager">
          <form
            className="agent-type-form"
            aria-label="New agent type"
            onSubmit={(event) => {
              event.preventDefault()
              add()
            }}
          >
            <input
              className="agent-type-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name (e.g. Reviewer)"
              aria-label="Agent type name"
            />
            <textarea
              className="agent-type-input agent-type-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Instructions — standing guidance for this role"
              aria-label="Agent type instructions"
              rows={2}
            />
            {skills.length > 0 && (
              <fieldset className="agent-type-skills">
                <legend>Skills</legend>
                {skills.map((skill) => (
                  <label key={skill.id} className="agent-type-skill" title={skill.description}>
                    <input
                      type="checkbox"
                      checked={skillIds.includes(skill.id)}
                      onChange={() => toggleSkill(skill.id)}
                      aria-label={`Attach ${skill.name}`}
                    />
                    {skill.name}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="agent-type-controls">
              <input
                className="agent-type-input agent-type-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Model (optional)"
                aria-label="Agent type model"
              />
              <label className="agent-type-readonly">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(event) => setReadOnly(event.target.checked)}
                  aria-label="Read-only role"
                />
                Read-only
              </label>
              <button type="submit" className="agent-type-add">
                Add
              </button>
            </div>
          </form>
          {types.length > 0 && (
            <ul className="agent-type-list">
              {types.map((type) => (
                <li key={type.id} className="agent-type-item">
                  <span className="agent-type-item-name" title={type.instructions}>
                    {type.name}
                    {type.readOnly ? ' · read-only' : ''}
                    {type.model === undefined ? '' : ` · ${type.model}`}
                    {type.skillIds === undefined ? '' : ` · ${type.skillIds.length} skill(s)`}
                  </span>
                  <button
                    type="button"
                    className="queue-action"
                    aria-label={`Delete ${type.name}`}
                    onClick={() => {
                      void remove(type.id)
                      if (selectedId === type.id) {
                        onSelect(null)
                      }
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="agent-type-form skill-form"
            aria-label="New skill"
            onSubmit={(event) => {
              event.preventDefault()
              addSkill()
            }}
          >
            <input
              className="agent-type-input"
              value={skillName}
              onChange={(event) => setSkillName(event.target.value)}
              placeholder="Skill name (e.g. Conventional commits)"
              aria-label="Skill name"
            />
            <input
              className="agent-type-input"
              value={skillDescription}
              onChange={(event) => setSkillDescription(event.target.value)}
              placeholder="One-line description"
              aria-label="Skill description"
            />
            <textarea
              className="agent-type-input agent-type-instructions"
              value={skillBody}
              onChange={(event) => setSkillBody(event.target.value)}
              placeholder="Skill instructions (the body injected into context)"
              aria-label="Skill body"
              rows={2}
            />
            <button type="submit" className="agent-type-add">
              Add skill
            </button>
          </form>
          {skills.length > 0 && (
            <ul className="agent-type-list">
              {skills.map((skill) => (
                <li key={skill.id} className="agent-type-item">
                  <span className="agent-type-item-name" title={skill.body}>
                    {skill.name}
                    {skill.description === '' ? '' : ` — ${skill.description}`}
                  </span>
                  <button
                    type="button"
                    className="queue-action"
                    aria-label={`Delete skill ${skill.name}`}
                    onClick={() => void removeSkill(skill.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
