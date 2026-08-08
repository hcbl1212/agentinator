---
name: cockpit-design
description: The visual system for Agentinator's UI — design tokens, pane anatomy, empty states, and status-bar patterns. Use when building or changing any UI.
---

# Cockpit design system

Agentinator looks like one instrument, not a collection of tabs. All UI matches the concept
mockups (dark, monospace, calm). Tokens live in `src/renderer/src/app.css` — always use the
CSS variables, never raw hex in components.

## Tokens

| Variable   | Value     | Use                                           |
| ---------- | --------- | --------------------------------------------- |
| `--bg`     | `#101614` | App background                                |
| `--panel`  | `#171f1c` | Raised surfaces: chrome bars, cards, lanes    |
| `--line`   | `#263230` | All borders and dividers (1px)                |
| `--ink`    | `#d7e2de` | Primary text                                  |
| `--soft`   | `#8ba39c` | Secondary text, empty states                  |
| `--faint`  | `#5d736d` | Labels, de-emphasized metadata                |
| `--accent` | `#35c2a5` | The one brand accent: app name, active states |

Semantic status colors (add to `app.css` when first needed, never inline): working `#5b9bff`
(blue), waiting/approval `#e0a83c` (amber), done `#47b881` (green), failed `#e06555` (red),
idle/blocked `#6b7f7a` (grey). Status is encoded in form as well as color (dot, pill, dashed
border) — never color alone.

## Type

Monospace everywhere (`ui-monospace, SF Mono, Menlo`), base 13px. No webfonts.

## Pane anatomy

- Pane label: uppercase, `--faint`, `0.7rem`, letter-spacing `0.12em`, bold — the established
  `.pane-label` class.
- Panes divide with 1px `--line` borders; interior padding ~`0.75rem 0.9rem`.
- Every pane has an **empty state**: one or two sentences in `--soft` that orient a first-time
  user and say what will appear there and when. Voice: plain, concrete, slightly forward-looking
  ("Agent activity will stream here — tool calls, edits, and tests."). Never a bare "No data".

## Status bar

A single bottom bar of small `--faint` chips separated by flex gap: counts, cost, cache
health. `--soft`/`--accent` for the emphasized value inside a chip. New global indicators go
here, not in pane headers.

## Interaction rules

- Everything interactive must be reachable by keyboard; visible focus states are required.
- Buttons/links use accent or ink on panel — no new colors without adding a token first.
- Deny/approve and destructive affordances use the semantic colors, not the accent.
- Prefer information density over chrome: no decorative icons, shadows, or gradients.
