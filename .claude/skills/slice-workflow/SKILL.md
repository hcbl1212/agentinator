---
name: slice-workflow
description: The definition of done for any slice of work in this repo — gates, commit, CI, and the try-this script. Use whenever finishing, committing, or shipping a change.
---

# Slice workflow

Agentinator is built in small, always-runnable slices. A slice is not done until every step
below has happened, in order.

## 1. Gates — all green locally, in this order

```sh
npm run lint
npm run format:check   # run `npm run format` first if it fails
npm run typecheck
npm test               # unit tests + coverage pinned at 100% lines/functions/branches/statements
npm run build          # electron-vite production build
```

- **Coverage is 100% or the slice is not done.** Never lower thresholds in `vitest.config.ts`.
- A `/* v8 ignore */` comment is allowed only with an inline justification on the same line or
  the line above (reserved for genuinely untestable code like process-exit paths). An
  unexplained ignore is a defect.
- Tests land in the same slice as the code, colocated (`foo.ts` → `foo.test.ts`). Never write
  code in one slice and tests in a later one.

## 2. Runnable check

`npm run dev` must launch the app and the slice's change must be visible or exercisable in the
running window. "Compiles and tests pass" without a runnable result is not done.

## 3. Commit — one commit per slice

- Subject: imperative, describing the user-visible outcome (e.g. "Slice 1d: live activity
  timeline rendered from the event log").
- Body: what changed and why, wrapped at ~72 chars.
- End the body with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## 4. Push and verify CI

```sh
git push origin main
gh run watch --repo hcbl1212/agentinator --exit-status \
  $(gh run list --repo hcbl1212/agentinator --limit 1 --json databaseId -q '.[0].databaseId')
```

CI must be green before the slice is reported as complete. If CI fails, fixing it is part of
the same slice.

## 5. The try-this script

Every completed slice ends with a message to Brian containing a **2–4 step checklist**: exactly
what to run or click, and what he should see. His feedback on those steps drives the next
slice. No slice report is complete without one.
