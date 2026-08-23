/**
 * A skill: a named, reusable instruction package that teaches an agent a
 * workflow or domain (a SKILL.md-style body). Attached to an agent type, its
 * body is injected into that role's system prompt. Serializes to plain JSON so
 * skills can be shared as files.
 */
export interface Skill {
  id: string
  /** Short human label (e.g. "Conventional commits"). */
  name: string
  /** One-line summary — what the skill teaches (shown in the manager list). */
  description: string
  /** The instructions themselves — the SKILL.md content injected into context. */
  body: string
}
