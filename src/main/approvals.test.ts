import { describe, expect, it } from 'vitest'

import type { EventPayloads, EventType } from '../shared/events'
import { DEFAULT_ALLOWLIST, PermissionBroker } from './approvals'
import type { EmitStored } from './approvals'

interface Recorded {
  type: EventType
  payload: EventPayloads[EventType]
}

function broker(rules = DEFAULT_ALLOWLIST): { broker: PermissionBroker; events: Recorded[] } {
  const events: Recorded[] = []
  const emit: EmitStored = (type, payload) => {
    events.push({ type, payload })
    return { seq: events.length, ts: 't', type, payload }
  }
  return { broker: new PermissionBroker(emit, rules), events }
}

describe('PermissionBroker', () => {
  it('auto-approves allowlisted tools and audits both events', async () => {
    const { broker: gate, events } = broker()

    const approved = await gate.decide('session_1', 'read', { path: 'src/a.ts' })

    expect(approved).toBe(true)
    expect(events.map((event) => event.type)).toEqual(['approval.requested', 'approval.resolved'])
    expect(events[1]?.payload).toMatchObject({ approved: true, via: 'allowlist' })
    expect(gate.pending()).toEqual([])
  })

  it('auto-approves bash commands matching the command pattern only', async () => {
    const { broker: gate, events } = broker()

    const testRun = await gate.decide('session_1', 'bash', { command: 'npm test' })
    expect(testRun).toBe(true)

    const install = gate.decide('session_1', 'bash', { command: 'npm install left-pad' })
    expect(gate.pending()).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('approval.requested')

    gate.resolve(gate.pending()[0]?.requestId ?? '', false)
    await expect(install).resolves.toBe(false)
  })

  it('treats a bash call without a command string as not allowlisted', () => {
    const { broker: gate } = broker()

    void gate.decide('session_1', 'bash', { script: ['rm', '-rf'] })

    expect(gate.pending()).toHaveLength(1)
  })

  it('blocks non-allowlisted tools until a user resolves, and audits the user decision', async () => {
    const { broker: gate, events } = broker()

    const decision = gate.decide('session_1', 'write', { path: 'src/a.ts' })
    const pending = gate.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ sessionId: 'session_1', tool: 'write' })

    gate.resolve(pending[0]?.requestId ?? '', true)

    await expect(decision).resolves.toBe(true)
    expect(events.at(-1)?.payload).toMatchObject({ approved: true, via: 'user' })
    expect(gate.pending()).toEqual([])
  })

  it('resolving an unknown request is a no-op', () => {
    const { broker: gate, events } = broker()

    gate.resolve('approval_missing', true)

    expect(events).toEqual([])
  })
})
