import { describe, expect, it } from 'vitest'

import { assembleSystemPrompt } from './promptAssembly'

describe('assembleSystemPrompt', () => {
  it('joins stable sections before volatile ones', () => {
    const prompt = assembleSystemPrompt({
      stable: ['You are an implementer.', 'Follow existing patterns.'],
      volatile: ['Current task: add a util.'],
    })

    expect(prompt).toBe(
      'You are an implementer.\n\nFollow existing patterns.\n\nCurrent task: add a util.',
    )
  })

  it('drops empty sections', () => {
    const prompt = assembleSystemPrompt({ stable: ['Base.', ''], volatile: [''] })

    expect(prompt).toBe('Base.')
  })

  it('rejects timestamps in stable sections — the classic cache-buster', () => {
    expect(() =>
      assembleSystemPrompt({ stable: ['Generated at 2026-08-08T14:00'], volatile: [] }),
    ).toThrow(/break prompt caching/)
  })

  it('rejects UUIDs in stable sections', () => {
    expect(() =>
      assembleSystemPrompt({
        stable: [`request ${'123e4567-e89b-42d3-a456-426614174000'}`],
        volatile: [],
      }),
    ).toThrow(/break prompt caching/)
  })

  it('allows timestamps in volatile sections, after the cacheable prefix', () => {
    const prompt = assembleSystemPrompt({
      stable: ['Base.'],
      volatile: ['Run started 2026-08-08T14:00.'],
    })

    expect(prompt).toBe('Base.\n\nRun started 2026-08-08T14:00.')
  })
})
