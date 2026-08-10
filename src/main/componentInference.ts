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
