---
name: event-fabric
description: Architecture invariants for the event-sourced core — the append-only log, event schema evolution, entity IDs, and the global selection context. Use when adding any event type, store code, or UI state.
---

# Event fabric invariants

The entire UI renders from one event-sourced store. These rules were chosen in Phase 1 because
retrofitting them is a rewrite. Breaking them is never a local decision — flag it to Brian.

## The log is the source of truth

- All state changes enter the system as **events appended to the SQLite log** (append-only:
  no UPDATE, no DELETE of historic rows). Views render from reducers/queries over the log.
- No pane may hold ad-hoc mutable state that can't be reconstructed by replaying the log.
  Ephemeral view state (scroll position, hover) is exempt; anything you'd want after an app
  restart is not.
- Replay is a feature contract: `--replay <fixture>` must always be able to drive the full UI
  from a recorded log. If a new feature can't be exercised via replay, its state is in the
  wrong place.

## Event schema evolution is append-only

- **Never mutate or repurpose an existing event type.** Add a new type (or a versioned variant)
  instead. Old fixtures must replay correctly forever — they are test inputs and user data.
- Every event carries: a monotonically-ordered ID, a timestamp, a `type` from the typed union,
  and the entity IDs it concerns. Payloads are typed — no `unknown` grab-bags.
- Reducers must tolerate unknown event types (skip, don't throw) so newer logs open in older
  code paths gracefully.

## Entities and IDs

- Every artifact — workspace, repo, session, agent, task, pipeline, diff, screenshot, finding,
  knowledge entry — is an **entity with a stable, globally-unique ID**, generated once at
  creation and never derived from mutable properties.
- Events reference entities by ID only. Denormalized copies of entity fields inside event
  payloads are snapshots, not references — name them accordingly (`titleAtDispatch`).
- Entity IDs are the deep-link and provenance currency: any feature that shows an artifact
  must be addressable by its ID.

## Selection context

- There is **one global selection context** (the selected entity ID + kind). Panes subscribe
  to it; none keeps a private notion of "current thing".
- Selecting an entity anywhere updates the shared context; every pane that can respond, does
  (focus-follows). New panes must consume the shared context, never fork it.

## Provider events

Vendor adapters emit **normalized** events into the log (see the provider-layer skill). The
store and UI never see vendor-specific shapes.
