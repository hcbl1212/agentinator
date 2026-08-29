import { describe, expect, it } from 'vitest'

import type { Pipeline } from './pipelines'
import type { Plan, PlanTaskView } from './plans'
import { blockageOf, downstreamCount } from './blockage'

const task = (
  id: string,
  dependsOn: string[],
  extra: Partial<PlanTaskView> = {},
): PlanTaskView => ({
  id,
  title: id,
  prompt: `do ${id}`,
  dependsOn,
  status: 'pending',
  ...extra,
})

// a ← b ← c, a ← d (b and d both wait on a; c waits on b), e stands alone.
const CHAIN: PlanTaskView[] = [
  task('a', [], { sessionId: 'sess_a' }),
  task('b', ['a']),
  task('c', ['b']),
  task('d', ['a'], { pipelineId: 'pipe_d' }),
  task('e', [], { sessionId: 'sess_e' }),
]

const PLAN: Plan = { id: 'pl1', title: 'Chain', requirement: 'r', tasks: CHAIN }

const PIPELINES: Pipeline[] = [
  {
    id: 'pipe_d',
    title: 'd as pipeline',
    stages: [
      { name: 'Plan', status: 'done', sessionId: 'stage_0' },
      { name: 'Implement', status: 'running', sessionId: 'stage_1' },
      { name: 'Review', status: 'pending' },
    ],
    done: false,
    approved: false,
  },
]

describe('downstreamCount', () => {
  it('counts transitive dependents once each, and leaves as zero', () => {
    expect(downstreamCount('a', CHAIN)).toBe(3) // b, c, d
    expect(downstreamCount('b', CHAIN)).toBe(1) // c
    expect(downstreamCount('c', CHAIN)).toBe(0)
    expect(downstreamCount('e', CHAIN)).toBe(0)
  })

  it('counts a diamond’s tip once', () => {
    const diamond = [task('a', []), task('b', ['a']), task('c', ['a']), task('d', ['b', 'c'])]
    expect(downstreamCount('a', diamond)).toBe(3)
  })
})

describe('blockageOf', () => {
  it('weights a session by its plan task’s downstream blockage', () => {
    expect(blockageOf('sess_a', [PLAN], [])).toBe(3)
    expect(blockageOf('sess_e', [PLAN], [])).toBe(0) // a leaf blocks nothing
  })

  it('reaches a pipelined task through its stage sessions', () => {
    expect(blockageOf('stage_1', [PLAN], PIPELINES)).toBe(0) // d blocks nothing
    // Give d a dependent and the stage inherits the weight.
    const withDependent: Plan = { ...PLAN, tasks: [...CHAIN, task('f', ['d'])] }
    expect(blockageOf('stage_0', [withDependent], PIPELINES)).toBe(1)
  })

  it('weights ad-hoc sessions (no plan work) at zero', () => {
    expect(blockageOf('sess_unknown', [PLAN], PIPELINES)).toBe(0)
    // A stage session whose pipeline no plan task launched is ad-hoc too.
    const foreign: Pipeline[] = [
      {
        id: 'pipe_foreign',
        title: 'composer pipeline',
        stages: [{ name: 'Plan', status: 'running', sessionId: 'stage_x' }],
        done: false,
        approved: false,
      },
    ]
    expect(blockageOf('stage_x', [PLAN], foreign)).toBe(0)
  })
})
