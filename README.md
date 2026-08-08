# Agentinator

[![CI](https://github.com/hcbl1212/agentinator/actions/workflows/ci.yml/badge.svg)](https://github.com/hcbl1212/agentinator/actions/workflows/ci.yml)
[![Coverage: 100%](https://img.shields.io/badge/coverage-100%25_enforced-brightgreen)](#quality-gates)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

**The visual harness for developing with AI.** A mission-control desktop app where AI coding
agents build software while you watch, steer, and approve — live activity timelines, an
interactive project plan, agent orchestration pipelines, and a system map that follows the work.

> **Status: early development.** Phase 1 (walking skeleton) is in progress. The cockpit shell
> opens; the first agent lands with the provider layer.

## Development

Requires Node 22+.

```sh
npm install
npm run dev           # launch the app with hot reload
npm test              # unit tests + 100% coverage gate (no network, no API key)
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm run build         # production build to out/
npm run smoke:claude  # opt-in: run the Claude adapter against real Claude (see below)
npm run replay:demo   # launch the app replaying a recorded session (no API spend)
```

## Connecting Claude

Agentinator talks to Claude through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
which runs the Claude Code runtime under the hood. Credentials resolve in this order:

1. `ANTHROPIC_API_KEY` — a Claude Console API key (usage-billed)
2. `CLAUDE_CODE_OAUTH_TOKEN` — a long-lived token minted from a subscription
3. **The Claude Code login already on your machine** — if you use Claude Code with a
   claude.ai Pro/Max subscription, Agentinator works with no configuration at all

So a subscription is enough: sessions count against your subscription's usage limits, and the
dollar figures in cost events are notional (nothing is billed beyond the subscription).

- **Verify your setup**: `npm run smoke:claude` runs one real session end to end through the
  adapter and asserts the normalized event stream. It is gated behind `CLAUDE_SMOKE=1` — CI
  and normal `npm test` runs never make a network call.
- **Headless environments** (CI, servers): run `claude setup-token` once on a logged-in
  machine and export the result as `CLAUDE_CODE_OAUTH_TOKEN`.
- **The test suite never needs credentials.** All unit tests run against the mock provider;
  the live smoke test is the only opt-in exception.

### Troubleshooting

**`Error: Electron uninstall` on `npm run dev`** — the Electron binary didn't download.
`npm install` runs a postinstall hook that detects and repairs this automatically; re-run
`npm install` (behind a proxy/firewall, make sure `github.com` release downloads are reachable).

## Quality gates

Every commit must pass, locally and in CI:

- `npm run lint` and `npm run format:check`
- `npm run typecheck`
- `npm test` — **coverage thresholds are pinned at 100%** (lines, functions, branches,
  statements). The build fails below 100.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[GPL-3.0](LICENSE)
