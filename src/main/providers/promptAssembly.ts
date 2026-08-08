/**
 * Cache-aware prompt assembly. Prompt caching is a prefix match: one changed
 * byte early in the prompt invalidates everything after it. So stable content
 * (system prompt, knowledge slice) comes first and must stay byte-identical
 * across requests; volatile content (task, per-run context) comes last.
 * Timestamps, UUIDs, and counters are forbidden in the stable section — they
 * are the classic silent cache-busters.
 */

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export interface PromptSections {
  /** Byte-stable across requests — the cacheable prefix. */
  stable: string[]
  /** Changes per run — always assembled after every stable section. */
  volatile: string[]
}

export function assembleSystemPrompt({ stable, volatile }: PromptSections): string {
  for (const section of stable) {
    if (ISO_TIMESTAMP.test(section) || UUID.test(section)) {
      throw new Error(
        'Volatile content (timestamp/UUID) found in a stable prompt section — this would silently break prompt caching. Move it to the volatile sections.',
      )
    }
  }
  return [...stable, ...volatile].filter((section) => section.length > 0).join('\n\n')
}
