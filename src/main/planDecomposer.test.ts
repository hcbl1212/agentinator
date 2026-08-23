import { describe, expect, it } from 'vitest'

import type { ClaudeQuery } from './providers/claude'
import {
  decomposePlanWith,
  extractTaskArray,
  fallbackTasks,
  scriptedDecomposer,
} from './planDecomposer'

describe('extractTaskArray', () => {
  it('strips a code fence and parses the tasks', () => {
    const tasks = extractTaskArray(
      '```json\n[{"title":"A","prompt":"do a","dependsOn":[]},' +
        '{"title":"B","prompt":"do b","dependsOn":[0]}]\n```',
    )

    expect(tasks).toEqual([
      { title: 'A', prompt: 'do a', dependsOn: [] },
      { title: 'B', prompt: 'do b', dependsOn: [0] },
    ])
  })

  it('handles a bare array with surrounding prose', () => {
    expect(extractTaskArray('Here you go: [{"title":"A"}] enjoy')).toEqual([
      { title: 'A', prompt: 'A', dependsOn: [] },
    ])
  })

  it('falls back a missing or blank prompt to the title', () => {
    expect(extractTaskArray('[{"title":"Tidy","prompt":"  "}]')).toEqual([
      { title: 'Tidy', prompt: 'Tidy', dependsOn: [] },
    ])
  })

  it('keeps only integer dependencies that point at earlier tasks, deduplicated', () => {
    const tasks = extractTaskArray(
      '[{"title":"A"},{"title":"B","dependsOn":[0,0,1,2,-1,0.5,"x"]},' +
        '{"title":"C","dependsOn":"not-an-array"}]',
    )

    // Self (1), forward (2), negative, fractional, and non-numeric deps drop;
    // a non-array dependsOn means none.
    expect(tasks?.[1].dependsOn).toEqual([0])
    expect(tasks?.[2].dependsOn).toEqual([])
  })

  it('rejects replies with no array, bad JSON, an empty array, or a bad item', () => {
    expect(extractTaskArray('no tasks here')).toBeNull()
    expect(extractTaskArray('[{"title": broken]')).toBeNull()
    expect(extractTaskArray('[]')).toBeNull()
    expect(extractTaskArray('[{"prompt":"no title"}]')).toBeNull()
    expect(extractTaskArray('[{"title":"   "}]')).toBeNull()
    expect(extractTaskArray('["not-an-object"]')).toBeNull()
    expect(extractTaskArray('{"title":"an object, not an array"}')).toBeNull()
  })
})

describe('fallbackTasks', () => {
  it('wraps the whole requirement in one dependency-free task', () => {
    expect(fallbackTasks('build the thing')).toEqual([
      { title: 'Implement the requirement', prompt: 'build the thing', dependsOn: [] },
    ])
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

describe('decomposePlanWith', () => {
  it('prompts the model with the requirement and returns the parsed tasks', async () => {
    let seen: Parameters<ClaudeQuery>[0] | undefined
    const query: ClaudeQuery = (args) => {
      seen = args
      return streamOf([
        { type: 'system', subtype: 'init' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"title":"A","prompt":"do a","dependsOn":[]}]' }],
          },
        },
        { type: 'result' },
      ])
    }

    const tasks = await decomposePlanWith(query)('add a settings page')

    expect(tasks).toEqual([{ title: 'A', prompt: 'do a', dependsOn: [] }])
    expect(seen?.prompt).toContain('add a settings page')
    expect(seen?.options.systemPrompt).toContain('JSON array')
    // Exploration is read-only: repo reads pass, anything else is denied.
    const canUseTool = seen?.options.canUseTool
    await expect(canUseTool?.('Grep', { pattern: 'x' })).resolves.toMatchObject({
      behavior: 'allow',
    })
    await expect(canUseTool?.('Bash', { command: 'rm' })).resolves.toMatchObject({
      behavior: 'deny',
    })
  })

  it('falls back to a single-task plan when the reply cannot be parsed', async () => {
    const query: ClaudeQuery = () =>
      streamOf([{ type: 'assistant', message: { content: [{ type: 'text', text: 'sorry?' }] } }])

    await expect(decomposePlanWith(query)('build it')).resolves.toEqual(fallbackTasks('build it'))
  })
})

describe('scriptedDecomposer', () => {
  it('is a deterministic Scaffold → Implement → Verify chain carrying the requirement', async () => {
    const tasks = await scriptedDecomposer('add a settings page')

    expect(tasks.map((task) => task.title)).toEqual(['Scaffold', 'Implement', 'Verify'])
    expect(tasks.map((task) => task.dependsOn)).toEqual([[], [0], [1]])
    for (const task of tasks) {
      expect(task.prompt).toContain('add a settings page')
    }
  })
})
