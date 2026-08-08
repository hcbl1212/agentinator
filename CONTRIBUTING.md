# Contributing to Agentinator

Thanks for your interest! Agentinator is developed in small, always-runnable slices.

## Ground rules

1. **100% test coverage is enforced.** `npm test` pins Vitest coverage thresholds at 100% for
   lines, functions, branches, and statements. A PR that lowers coverage cannot merge. If a line
   is genuinely untestable (e.g. a process-exit path), use `/* v8 ignore */` **with an inline
   comment justifying it** — unexplained ignores are rejected in review.
2. **Every slice ends runnable.** A change isn't done until `npm run dev` launches and shows it
   working.
3. **All gates green before pushing**: `npm run lint`, `npm run format:check`,
   `npm run typecheck`, `npm test`, `npm run build`. CI runs the same gates on every push and PR.

## Workflow

- Fork / branch from `main`.
- Keep commits scoped to one slice of work; write tests alongside the code, not after.
- Open a PR — the template asks what to click to see the change working.

## Project shape

- `src/main/` — Electron main process (Node): provider layer, git, event store.
- `src/renderer/` — React UI (the cockpit).
- Tests are colocated: `foo.ts` → `foo.test.ts`.
