import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ClaudeQuery } from './providers/claude'
import { extractPropsLiteral, inferPropsWith, makePropInferrer } from './componentInference'

describe('extractPropsLiteral', () => {
  it('strips a code fence and returns the object literal', () => {
    expect(extractPropsLiteral('```js\n{ completedValue: 3, totalValue: 10 }\n```')).toBe(
      '{ completedValue: 3, totalValue: 10 }',
    )
  })

  it('handles a bare object with surrounding prose', () => {
    expect(extractPropsLiteral('Here are the props: { label: "Hi" } — enjoy')).toBe(
      '{ label: "Hi" }',
    )
  })

  it('falls back to an empty object when no literal is present', () => {
    expect(extractPropsLiteral('no object here')).toBe('{}')
  })
})

function streamOf(messages: unknown[]): ReturnType<ClaudeQuery> {
  return (async function* () {
    for (const message of messages) {
      yield message
      await Promise.resolve()
    }
  })() as ReturnType<ClaudeQuery>
}

describe('inferPropsWith', () => {
  it('prompts the model with the source and returns the parsed props', async () => {
    let seen: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      seen = args
      return streamOf([
        { type: 'system', subtype: 'init' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'ignored' },
              { type: 'text', text: '```js\n{ completedValue: 3, totalValue: 10 }\n```' },
            ],
          },
        },
        { type: 'result' },
      ])
    }

    const props = await inferPropsWith(query)('export const Bar = (p) => null', '/app')

    expect(props).toBe('{ completedValue: 3, totalValue: 10 }')
    expect(seen?.prompt).toContain('export const Bar')
    expect(seen?.options.systemPrompt).toContain('object literal')
    expect(seen?.options.cwd).toBe('/app')
  })

  it('ignores non-assistant and malformed messages', async () => {
    const query: ClaudeQuery = () =>
      streamOf(['not-a-record', { type: 'assistant' }, { type: 'assistant', message: {} }])

    await expect(inferPropsWith(query)('source', '/app')).resolves.toBe('{}')
  })
})

describe('makePropInferrer', () => {
  const okQuery: ClaudeQuery = () =>
    streamOf([{ type: 'assistant', message: { content: [{ type: 'text', text: '{ n: 1 }' }] } }])

  it('reads the component file and infers its props', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentinator-infer-'))
    writeFileSync(join(dir, 'Bar.tsx'), 'export const Bar = () => null')

    await expect(makePropInferrer(okQuery)(dir, 'Bar.tsx')).resolves.toBe('{ n: 1 }')
  })

  it('rejects when the component file is missing', async () => {
    await expect(makePropInferrer(okQuery)('/nope', 'Bar.tsx')).rejects.toThrow()
  })
})
