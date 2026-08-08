---
name: testing-patterns
description: How to reach and keep 100% coverage in this repo — Electron mocking, jsdom setup, platform stubbing, import-time side effects, and the mock-provider-first rule. Use when writing or fixing any test.
---

# Testing patterns

Coverage thresholds are pinned at 100% (lines, functions, branches, statements). These are the
established patterns that make that achievable without theater.

## Environments

- Default test environment is **node** (main-process code, scripts).
- Renderer tests declare jsdom with a docblock as the **first line** of the file:
  ```ts
  // @vitest-environment jsdom
  ```
- Renderer tests use `@testing-library/react`; matchers come from
  `@testing-library/jest-dom/vitest` (wired in `vitest.setup.ts`).

## Mocking Electron (main-process tests)

Electron cannot be imported in tests. Mock it with `vi.hoisted` + `vi.mock` — see
`src/main/index.test.ts` for the canonical shape:

```ts
const { mockApp, MockBrowserWindow, mockShell } = vi.hoisted(() => {
  /* build mocks here — this runs before imports */
})
vi.mock('electron', () => ({ app: mockApp, BrowserWindow: MockBrowserWindow, shell: mockShell }))
```

Design main-process modules for this: export small named functions (`createWindow`,
`handleActivate`, …) with injectable collaborators, so every branch is reachable from tests.

## Deterministic platform branches

Never write tests that branch on the host platform — they cover different code on different
machines. Stub it:

```ts
const real = Object.getOwnPropertyDescriptor(process, 'platform')
Object.defineProperty(process, 'platform', { value: 'linux' })
try {
  /* assert */
} finally {
  Object.defineProperty(process, 'platform', real as PropertyDescriptor)
}
```

## Import-time side effects

Modules with top-level execution (renderer entry, postinstall scripts) are tested by
controlling the environment **before** a dynamic import, with `vi.resetModules()` in
`beforeEach` so each test gets a fresh module. Both branches of any import-time conditional
need a test (see `src/renderer/src/main.test.tsx`).

## Env vars

Use `vi.stubEnv(name, value)` / `vi.stubEnv(name, undefined)` and `vi.unstubAllEnvs()` in
`beforeEach` — never mutate `process.env` directly.

## Mock provider first

Nothing in the test suite may require a live model API call or an `ANTHROPIC_API_KEY`. All
provider-layer consumers are tested against the mock provider; vendor adapters are tested by
asserting the normalized events they emit from recorded/synthetic vendor payloads. Replay
fixtures double as deterministic inputs for e2e tests.

## Injectable seams over ignores

If code is hard to cover, the fix is a seam (injectable dependency, extracted function) — not
a `/* v8 ignore */`. Ignores require an inline justification and are reserved for genuinely
untestable lines.
