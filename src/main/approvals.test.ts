import { describe, expect, it } from 'vitest'

import type { EventPayloads, EventType } from '../shared/events'
import { PermissionBroker } from './approvals'
import type { EmitStored, Schedule } from './approvals'

interface Recorded {
  type: EventType
  payload: EventPayloads[EventType]
}

/** A schedule whose deferred callbacks fire only when flush() is called. */
function manualSchedule(): { schedule: Schedule; flush: () => void; scheduledCount: () => number } {
  const tasks = new Set<() => void>()
  return {
    schedule: (fn) => {
      tasks.add(fn)
      return () => tasks.delete(fn)
    },
    flush: () => {
      for (const fn of [...tasks]) {
        tasks.delete(fn)
        fn()
      }
    },
    scheduledCount: () => tasks.size,
  }
}

function broker(options: ConstructorParameters<typeof PermissionBroker>[1] = {}): {
  broker: PermissionBroker
  events: Recorded[]
} {
  const events: Recorded[] = []
  const emit: EmitStored = (type, payload) => {
    events.push({ type, payload })
    return { seq: events.length, ts: 't', type, payload }
  }
  return { broker: new PermissionBroker(emit, options), events }
}

describe('PermissionBroker', () => {
  it('auto-approves allowlisted tools immediately and audits both events', async () => {
    const { broker: gate, events } = broker()

    const approved = await gate.decide('session_1', 'read', { path: 'src/a.ts' })

    expect(approved).toBe(true)
    expect(events.map((event) => event.type)).toEqual(['approval.requested', 'approval.resolved'])
    expect(events[1]?.payload).toMatchObject({ approved: true, via: 'allowlist' })
    expect(gate.pending()).toEqual([])
  })

  it('auto-approves bash commands matching the command pattern only', async () => {
    const { broker: gate } = broker()

    await expect(gate.decide('session_1', 'bash', { command: 'npm test' })).resolves.toBe(true)

    gate.decide('session_1', 'bash', { command: 'npm install left-pad' })
    expect(gate.pending()).toHaveLength(1)
  })

  it('treats a bash call without a command string as not allowlisted', () => {
    const { broker: gate } = broker()

    void gate.decide('session_1', 'bash', { script: ['rm', '-rf'] })

    expect(gate.pending()).toHaveLength(1)
  })

  it('commits an approval immediately — no grace window', async () => {
    const timer = manualSchedule()
    const { broker: gate, events } = broker({ schedule: timer.schedule })

    const decision = gate.decide('session_1', 'write', { path: 'src/a.ts' })
    gate.resolve(gate.pending()[0]?.requestId ?? '', true)

    expect(timer.scheduledCount()).toBe(0)
    await expect(decision).resolves.toBe(true)
    expect(events.at(-1)?.payload).toMatchObject({ approved: true, via: 'user' })
  })

  it('defers a deny through the grace window before it reaches the agent', async () => {
    const timer = manualSchedule()
    const { broker: gate, events } = broker({ schedule: timer.schedule })

    const decision = gate.decide('session_1', 'write', { path: 'src/a.ts' })
    const pending = gate.pending()
    expect(pending).toHaveLength(1)

    gate.resolve(pending[0]?.requestId ?? '', false)

    // Scheduled, but the agent has NOT been told yet — no resolved event.
    expect(gate.pending()).toEqual([])
    expect(timer.scheduledCount()).toBe(1)
    expect(events.map((event) => event.type)).toEqual(['approval.requested'])

    timer.flush()

    await expect(decision).resolves.toBe(false)
    expect(events.at(-1)?.payload).toMatchObject({ approved: false, via: 'user' })
  })

  it('undo aborts a scheduled deny and returns it to pending', async () => {
    const timer = manualSchedule()
    const { broker: gate, events } = broker({ schedule: timer.schedule })

    const decision = gate.decide('session_1', 'write', { path: 'src/a.ts' })
    const requestId = gate.pending()[0]?.requestId ?? ''

    gate.resolve(requestId, false)
    gate.undo(requestId)

    expect(timer.scheduledCount()).toBe(0)
    expect(gate.pending().map((approval) => approval.requestId)).toEqual([requestId])
    // Nothing committed to the agent or the audit trail.
    expect(events.map((event) => event.type)).toEqual(['approval.requested'])

    // The same request can now be approved for real.
    gate.resolve(requestId, true)
    await expect(decision).resolves.toBe(true)
  })

  it('resolving an unknown request is a no-op', () => {
    const { broker: gate, events } = broker()

    gate.resolve('approval_missing', true)

    expect(events).toEqual([])
  })

  it('undo of an unknown or already-committed deny is a no-op', () => {
    const timer = manualSchedule()
    const { broker: gate } = broker({ schedule: timer.schedule })

    gate.undo('approval_missing')

    const decision = gate.decide('session_1', 'write', { path: 'src/a.ts' })
    const requestId = gate.pending()[0]?.requestId ?? ''
    gate.resolve(requestId, false)
    timer.flush()
    gate.undo(requestId) // already committed

    expect(gate.pending()).toEqual([])
    return expect(decision).resolves.toBe(false)
  })

  it('uses real timers by default, and undo cancels a pending deny timeout', () => {
    const { broker: gate } = broker({ graceMs: 10_000 })

    void gate.decide('session_1', 'write', { path: 'a.ts' })
    const requestId = gate.pending()[0]?.requestId ?? ''
    gate.resolve(requestId, false)
    gate.undo(requestId)

    // Back to pending with the real setTimeout cleared (no leaked timer).
    expect(gate.pending().map((approval) => approval.requestId)).toEqual([requestId])
  })
})
