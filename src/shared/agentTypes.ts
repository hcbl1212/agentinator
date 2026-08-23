/**
 * A reusable agent preset: a named configuration a task can launch under, so
 * "reviewer", "test-writer", or "UI-iterator" become one-click roles instead of
 * a hand-typed prompt each time. Vendor-neutral — the provider maps the fields
 * onto its own mechanisms (instructions → system prompt, model → model, readOnly
 * → tool policy). Serializes to plain JSON so types can be shared as files.
 */
export interface AgentType {
  id: string
  /** Short human label shown in the picker (e.g. "Reviewer"). */
  name: string
  /** Extra system-prompt instructions layered on the base prompt — the role's
   * standing guidance. May be empty. */
  instructions: string
  /** The model this role runs on, or undefined to use the provider default. */
  model?: string
  /** Run the role read-only (may read/search but not edit or run commands) —
   * e.g. a reviewer that shouldn't touch the code. */
  readOnly?: boolean
  /** Ids of skills attached to this role — their bodies are injected into the
   * agent's context on every launch under this type. */
  skillIds?: string[]
}
