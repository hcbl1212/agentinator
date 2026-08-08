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
npm run dev        # launch the app with hot reload
npm test           # unit tests + 100% coverage gate
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run build      # production build to out/
```

## Quality gates

Every commit must pass, locally and in CI:

- `npm run lint` and `npm run format:check`
- `npm run typecheck`
- `npm test` — **coverage thresholds are pinned at 100%** (lines, functions, branches,
  statements). The build fails below 100.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[GPL-3.0](LICENSE)
