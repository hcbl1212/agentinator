import { query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import { inferPropsWith } from './componentInference'
import type { ClaudeQuery } from './providers/claude'

/**
 * Opt-in smoke against REAL Claude: the "Infer props" AI must turn a component's
 * source into a usable props object literal. Skipped unless CLAUDE_SMOKE is set:
 *
 *   npm run smoke:infer
 */
describe.skipIf(process.env['CLAUDE_SMOKE'] === undefined)(
  'component prop inference (live smoke)',
  () => {
    it('generates a props literal for a real component', { timeout: 120_000 }, async () => {
      const infer = inferPropsWith(query as unknown as ClaudeQuery)
      const source =
        'export interface ProgressBarProps {\n' +
        '  completedValue: number\n' +
        '  totalValue: number\n' +
        '  showPercentage?: boolean\n' +
        '}\n' +
        'export const ProgressBar = (p: ProgressBarProps) => null'

      const props = await infer(source, process.cwd())
      console.log('inferred props:', props)

      // A parseable object literal that mentions the required props.
      expect(props).toMatch(/^\{[\s\S]*\}$/)
      expect(props).toContain('completedValue')
      expect(props).toContain('totalValue')
      expect(() => {
        JSON.parse(props.replace(/(\w+):/g, '"$1":'))
      }).not.toThrow()
    })
  },
)
