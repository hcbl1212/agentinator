import { useState } from 'react'

import { useAgentTypes } from '../state/agentTypes'

/**
 * Picks the agent-type preset a new task launches under, and manages the set.
 * "Default agent" is the base behaviour; other options apply a role's
 * instructions, model, and read-only posture. The Manage panel creates and
 * deletes types inline.
 */
export function AgentTypeBar({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  const { types, save, remove } = useAgentTypes()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [model, setModel] = useState('')
  const [readOnly, setReadOnly] = useState(false)

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
    })
    setName('')
    setInstructions('')
    setModel('')
    setReadOnly(false)
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
        </div>
      )}
    </div>
  )
}
