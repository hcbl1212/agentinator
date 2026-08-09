# Agentinator

[![CI](https://github.com/hcbl1212/agentinator/actions/workflows/ci.yml/badge.svg)](https://github.com/hcbl1212/agentinator/actions/workflows/ci.yml)
[![Coverage: 100%](https://img.shields.io/badge/coverage-100%25_enforced-brightgreen)](#quality-gates)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

**The visual harness for developing with AI.** A mission-control desktop app where AI coding
agents build software while you watch, steer, and approve — a fleet of agents, live activity
timelines, a cumulative diff, blocking approval cards, and spend/limit awareness that
understands both API-key billing and subscription plans.

> **Status: early development.** The walking skeleton is well past first light — you can run a
> real fleet of Claude agents on a repo, steer and approve them, and see cost and plan-limit
> state live. The larger roadmap (project planner, orchestration pipelines, a system map that
> follows the work) is still ahead.

## How it works

Three ideas hold the whole thing together:

- **An append-only event log is the single source of truth.** Every fact — a session started, a
  token of text, a tool call, a file diff, a cost sample, an approval, a rate-limit signal — is a
  typed event appended to a local SQLite log ([`src/shared/events.ts`](src/shared/events.ts)).
  Every pane in the UI is a pure function of that log, so replay, time-travel, and offline
  consistency come nearly for free. Nothing is stored twice.
- **A vendor-neutral provider layer.** Adapters map a vendor's stream _into_ the normalized event
  schema; the UI renders _from_ it and never sees vendor specifics. Claude is the first adapter
  (via the Claude Agent SDK); a scripted **mock provider** drives every test with no network, and
  a deterministic **e2e provider** backs the Playwright suite. Swapping or adding a vendor touches
  one adapter, not the app.
- **Focus-follows selection.** Selecting an agent scopes the whole cockpit to it — the timeline
  shows that agent's conversation, the diff shows its changes — while the status bar stays global.

### The cockpit

| Pane                  | What it does                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fleet rail** (left) | Every live agent as a selectable row. A status dot reads at a glance — **yellow** working, **blue** done (idle, awaiting you), **red** failed (stays put so you notice). Each row shows its vendor · model and its own running spend. A per-row **✕** removes an agent (stopping it if live).                                                 |
| **Timeline** (center) | The selected agent's conversation and activity, rendered from the log — text, thinking, tool calls, diffs, cost. Search the whole log store-side, load earlier history on demand, or clear the view (events are immutable; history comes back). Internal bookkeeping (idle turns, resume tokens, the model, usage samples) never clutters it. |
| **Inspector** (right) | Tabbed **Diff** (cumulative, per-file, syntax-highlighted, scoped to the selected agent) and **Preview** (the target app).                                                                                                                                                                                                                    |
| **Composer** (bottom) | Start a task, or reply to the selected agent — Enter sends. Permission requests surface here as **approval cards**: Approve commits immediately; Deny runs a short grace countdown you can **Undo**. `/clear` drops the current agent back to a fresh prompt.                                                                                 |
| **Status bar**        | Global picture: lifetime spend, log size, prompt-cache health, plan-limit gauge, and a **budgets** editor.                                                                                                                                                                                                                                    |

### What's working today

- **A multi-agent fleet** — launch several agents, switch between them, remove them.
- **Live activity + cumulative diff**, scoped to the selected agent.
- **Blocking approvals** with a deny-grace/undo window and a per-project allowlist.
- **Session resume across a restart** — a reopened app reconnects a session via the provider's
  native resume (proven live by `npm run smoke:resume`).
- **Cost & plan-limit awareness** — see [Cost, budgets & plan limits](#cost-budgets--plan-limits).
- **Replay mode** — review UI against a recorded session with zero API spend.

## Development

Requires Node 22+.

```sh
npm install
npm run dev            # launch the app with hot reload
npm test               # unit tests + 100% coverage gate (no network, no API key)
npm run test:e2e       # build, then drive the app with Playwright (Electron)
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm run build          # production build to out/
npm run replay:demo    # launch replaying a recorded session (no API spend)
```

A [lefthook](https://github.com/evilmartians/lefthook) pre-push hook runs the same gates as CI
locally before every push; skip it with `git push --no-verify`.

## Connecting Claude

Agentinator talks to Claude through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
which runs the Claude Code runtime under the hood. Credentials resolve in this order:

1. `ANTHROPIC_API_KEY` — a Claude Console API key (usage-billed)
2. `CLAUDE_CODE_OAUTH_TOKEN` — a long-lived token minted from a subscription
3. **The Claude Code login already on your machine** — if you use Claude Code with a
   claude.ai Pro/Max subscription, Agentinator works with no configuration at all

So a subscription is enough. Agentinator detects which mode you're in and adjusts the UI (below).

- **Verify your setup**: opt-in live smokes, all gated behind `CLAUDE_SMOKE=1` so CI and normal
  `npm test` runs never touch the network:
  - `npm run smoke:claude` — one real session end to end through the adapter.
  - `npm run smoke:dogfood` — a real task on this repo through the full session manager (the
    path the "Run task" button uses).
  - `npm run smoke:resume` — proves native resume survives a simulated restart.
  - `npm run smoke:usage` — proves the SDK's usage/plan-limit signal is available.
- **Headless environments** (CI, servers): run `claude setup-token` once on a logged-in machine
  and export the result as `CLAUDE_CODE_OAUTH_TOKEN`.
- **The test suite never needs credentials.** Unit tests run against the mock provider; the live
  smokes are the only opt-in exception.

## Cost, budgets & plan limits

Cost isn't one thing — it depends on how you're billed, and Agentinator models both:

- **API key (metered).** Dollars are real money. The status bar shows lifetime spend, each agent
  shows its own spend in the rail, and the **budgets** editor sets spend ceilings — session
  (per-agent) plus time windows (hour/day/week/month). An agent that crosses a ceiling is stopped
  and the breach is logged. Cost is billed **per turn** (the adapter records each turn's delta of
  the SDK's running total, so nothing is double-counted).
- **Subscription (Pro/Max).** Plan limits are the real ceiling, so the status bar shows a **live
  plan gauge** (5-hour and 7-day window utilization, resets, per-model windows) and marks dollars
  as an `est.` — a what-it-would-cost estimate, since you aren't billed per token.
- **Hitting a limit is a decision, not a wall.** When the provider signals that you're approaching
  or have hit a limit, a **capacity banner** appears with the window, the reset time, and your
  overage state — and a link straight to plan settings, since overage/credits are enabled there.

## Quality gates

Every commit must pass, locally and in CI:

- `npm run lint` and `npm run format:check`
- `npm run typecheck`
- `npm test` — **coverage thresholds are pinned at 100%** (lines, functions, branches,
  statements). The build fails below 100.
- `npm run test:e2e` — Playwright drives the built Electron app.

CI runs the fast gates on Ubuntu in parallel with the macOS build + e2e job, with dependency
caching. See [CONTRIBUTING.md](CONTRIBUTING.md) for the slice workflow.

### Troubleshooting

**`Error: Electron uninstall` on `npm run dev`** — the Electron binary didn't download.
`npm install` runs a postinstall hook that detects and repairs this automatically; re-run
`npm install` (behind a proxy/firewall, make sure `github.com` release downloads are reachable).

## License

[GPL-3.0](LICENSE)
