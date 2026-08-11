import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ClaudeQuery } from './providers/claude'

/** Infers realistic props for a component from its source — the AI behind
 * "Infer props". Injected so callers stay testable without a live model. */
export type PropInferrer = (source: string, cwd: string) => Promise<string>

const SYSTEM_PROMPT =
  'You set up a single React component for isolated preview. Given its source, output ONLY a ' +
  'JavaScript object literal of realistic props to render it — no imports, no prose, no code ' +
  'fences, no `const`. Use () => {} for function props, and short realistic strings/numbers/' +
  'booleans/arrays/objects for the rest. Return {} if the component needs no props.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Concatenate the assistant text blocks from an SDK message stream. */
function assistantText(message: unknown): string {
  if (!isRecord(message) || message['type'] !== 'assistant') {
    return ''
  }
  const nested = message['message']
  if (!isRecord(nested) || !Array.isArray(nested['content'])) {
    return ''
  }
  return nested['content']
    .map((block) => (isRecord(block) && block['type'] === 'text' ? String(block['text']) : ''))
    .join('')
}

/** Pull a bare object literal out of the model's reply — strip any code fence,
 * then take from the first `{` to the last `}`. Falls back to `{}`. */
export function extractPropsLiteral(text: string): string {
  const fenced = /```(?:[a-zA-Z]*)?\n?([\s\S]*?)```/.exec(text)
  const body = (fenced === null ? text : fenced[1]).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start !== -1 && end > start ? body.slice(start, end + 1) : '{}'
}

/** Build a PropInferrer over the injected SDK query. */
export function inferPropsWith(query: ClaudeQuery): PropInferrer {
  return async (source, cwd) => {
    const stream = query({
      prompt:
        'Component source:\n```tsx\n' + source + '\n```\nReturn the props object literal only.',
      options: { cwd, systemPrompt: SYSTEM_PROMPT },
    })
    let text = ''
    for await (const message of stream) {
      text += assistantText(message)
    }
    return extractPropsLiteral(text)
  }
}

/** The renderer-facing inferrer: reads the component file from disk and infers
 * its props. Rejects if the file can't be read (surfaced in the pane). */
export function makePropInferrer(
  query: ClaudeQuery,
): (root: string, file: string) => Promise<string> {
  const infer = inferPropsWith(query)
  return async (root, file) => {
    const source = readFileSync(join(root, file), 'utf8')
    return infer(source, root)
  }
}

const WRAPPER_SYSTEM =
  'You generate a React wrapper for previewing one component in isolation. Explore the app (Read/' +
  'Grep/Glob) to find the context the target component needs — router, Apollo/GraphQL client, ' +
  'Redux store, i18n, and any React contexts it consumes — and produce a wrapper that supplies ' +
  'them with mocked or in-memory values so it renders with NO running backend or login. Prefer the ' +
  "app's own provider components when they self-contain their client; otherwise use MemoryRouter, " +
  "Apollo MockedProvider, and mock context values. CRITICAL: also import the app's GLOBAL " +
  'STYLESHEETS at the top of the wrapper — Tailwind, SCSS, and any CSS reset that the app entry ' +
  '(index/main/App) imports — and reproduce the app root wrapper element (e.g. the id/class on ' +
  '#app) so the component renders STYLED, not as unstyled plain text. ALSO reproduce the ' +
  "component's LAYOUT ANCESTORS — the page container, content-background, and header/nav chrome " +
  'divs it is nested inside in the real app (trace up from where the component is routed/rendered ' +
  'and copy those wrapper elements and their classes around `children`) — so page-level styling ' +
  'like the content background and padding shows in isolation, not just the component itself. ' +
  'Output ONLY a complete .tsx module that default-exports a component taking `children`. No ' +
  'prose, no code fences.'

/** Read-only tools the wrapper generator may use to explore the app. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'])

/** Extract a code module from the model's reply — the fence body if fenced,
 * else the whole trimmed text. */
export function extractModule(text: string): string {
  const fenced = /```(?:tsx?|jsx?|typescript|javascript)?\n?([\s\S]*?)```/.exec(text)
  return (fenced === null ? text : fenced[1]).trim()
}

/** Generate a wrapper module for a component — reads its source, lets the agent
 * explore read-only, and returns the wrapper .tsx source. */
export function inferWrapperWith(
  query: ClaudeQuery,
): (source: string, cwd: string) => Promise<string> {
  return async (source, cwd) => {
    const stream = query({
      prompt: 'Target component source:\n```tsx\n' + source + '\n```\nGenerate the wrapper module.',
      options: {
        cwd,
        systemPrompt: WRAPPER_SYSTEM,
        canUseTool: (toolName, input) =>
          Promise.resolve(
            READ_ONLY_TOOLS.has(toolName)
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'Preview setup is read-only.' },
          ),
      },
    })
    let text = ''
    for await (const message of stream) {
      text += assistantText(message)
    }
    return extractModule(text)
  }
}

export function makeWrapperInferrer(
  query: ClaudeQuery,
): (root: string, file: string) => Promise<string> {
  const infer = inferWrapperWith(query)
  return async (root, file) => {
    const source = readFileSync(join(root, file), 'utf8')
    return infer(source, root)
  }
}
