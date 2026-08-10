import type { EventType } from '../../shared/events'

/**
 * The events the UI renders a session from — the parity contract every capable
 * provider must satisfy. The deterministic e2e stand-in used by the Playwright
 * suite MUST emit the same vocabulary as the real vendor adapters, or the e2e
 * tests validate a fiction (that's how the file.diffed gap shipped: the e2e
 * provider emitted it, the real Claude adapter didn't, and every test passed).
 *
 * Provider tests assert their emitted event set ⊇ this list. Adding a new
 * UI-critical event here forces every provider's tests to prove they emit it.
 *
 * Excluded on purpose: `account.usage` / `account.limit` (vendor-specific,
 * sampled from an experimental API — not universal) and `preview.captured`
 * (emitted by the PreviewController, not a provider).
 */
export const PROVIDER_CONTRACT_EVENTS: readonly EventType[] = [
  'session.started',
  'session.ended',
  'session.idle',
  'session.model',
  'session.auth',
  'session.resumable',
  'agent.text',
  'agent.thinking',
  'agent.question',
  'tool.called',
  'tool.resulted',
  'file.diffed',
  'cost.usage',
]

/** The contract events missing from an emitted set — empty means conformant. */
export function missingContractEvents(emitted: Iterable<string>): EventType[] {
  const seen = new Set(emitted)
  return PROVIDER_CONTRACT_EVENTS.filter((type) => !seen.has(type))
}
