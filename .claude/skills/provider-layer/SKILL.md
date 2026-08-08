---
name: provider-layer
description: Rules for the vendor-agnostic provider layer — normalized events, capability flags, and cache-aware prompt assembly. Use when building or touching any vendor adapter, prompt construction, or token accounting.
---

# Provider layer rules

The provider layer is the vendor abstraction everything renders through. Two goals: the UI
never knows which vendor is underneath, and prompts are assembled so caching always works.

## Normalized events only

- Adapters implement the `AgentProvider` interface (start session, send message, stream
  events, cancel, cost) and emit **normalized event types** into the event log: session
  lifecycle, assistant text, thinking, tool call/result, file diff, error, cost/tokens.
- Vendor-specific payload shapes never cross the adapter boundary. If a vendor exposes
  something the schema can't represent, extend the normalized schema (append-only — see the
  event-fabric skill), don't leak the raw shape.
- Adapters are tested against recorded/synthetic vendor payloads, asserting the normalized
  events out. The **mock provider** implements the same interface and is what all consumers
  test against — no test requires an API key.

## Capability flags, not instanceof

Consumers ask `provider.capabilities` (vision, tool use, streaming, context size, task
budgets, native skills, batch API, prompt caching style) and degrade gracefully. Never branch
on the vendor's name outside its own adapter.

## Cache-aware prompt assembly (the discipline that saves 10×)

Prompt caching is a **prefix match** — one changed byte invalidates everything after it.
Assembly rules, enforced in the shared prompt-builder (never per-call-site):

1. Order: stable system prompt → deterministically-ordered tool list (sorted by name) →
   stable context blocks (knowledge slice) → volatile content (task, messages) last.
2. **Never interpolate timestamps, UUIDs, counters, or request IDs into the prefix.** Dynamic
   context goes after the last cache breakpoint (or in a later message).
3. Cache breakpoints sit at stability boundaries; serialization must be deterministic
   (sorted keys, no Set/Map iteration order leaks).
4. Surface `cache_read_input_tokens` from responses into the normalized cost events — the
   status bar's cache-health chip and tests depend on it. Zero reads across repeated turns is
   a regression, not a curiosity.

## Token accounting

- Use each vendor's count-tokens endpoint via the adapter. **Never tiktoken for non-OpenAI
  models** (undercounts Claude by 15–20%+).
- Costs are computed from per-vendor price tables kept in the adapter, emitted as normalized
  cost events.

## Claude adapter specifics (first adapter)

- Built on `@anthropic-ai/claude-agent-sdk` in the Electron main process.
- Prefer vendor-native mechanisms behind capability flags: task budgets (agent-paced
  countdown), batch API for the batch lane (50% discount), native skills.
- Default model comes from configuration, not hardcoded; per-dispatch model + effort are
  parameters, chosen by agent type/preset.
