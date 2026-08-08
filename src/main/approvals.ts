import type { PendingApproval } from '../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../shared/events'
import { createEntityId } from '../shared/events'

export type EmitStored = <T extends EventType>(type: T, payload: EventPayloads[T]) => StoredEvent<T>

export interface AllowRule {
  tool: string
  /** For bash-like tools: the command must match this regex to auto-allow. */
  commandPattern?: string
}

/** Routine, read-only or repo-safe operations that never need a card. */
export const DEFAULT_ALLOWLIST: AllowRule[] = [
  { tool: 'read' },
  { tool: 'glob' },
  { tool: 'grep' },
  { tool: 'bash', commandPattern: '^npm (test|run (lint|typecheck|format:check))\\b' },
]

/**
 * The permission gate between agents and side effects. Allowlisted calls
 * auto-approve (still audited — both events land in the log); everything
 * else blocks the calling provider until a human resolves the card. Agents
 * can never resolve approvals: the only path is the approvals IPC.
 */
export class PermissionBroker {
  readonly #emit: EmitStored
  readonly #rules: AllowRule[]
  #pending = new Map<string, { approval: PendingApproval; resolve: (approved: boolean) => void }>()

  constructor(emit: EmitStored, rules: AllowRule[] = DEFAULT_ALLOWLIST) {
    this.#emit = emit
    this.#rules = rules
  }

  #allowlisted(tool: string, input: unknown): boolean {
    return this.#rules.some((rule) => {
      if (rule.tool !== tool) {
        return false
      }
      if (rule.commandPattern === undefined) {
        return true
      }
      const command = (input as { command?: unknown }).command
      return typeof command === 'string' && new RegExp(rule.commandPattern).test(command)
    })
  }

  decide(sessionId: string, tool: string, input: unknown): Promise<boolean> {
    const requestId = createEntityId('approval')
    this.#emit('approval.requested', { sessionId, requestId, tool, input })

    if (this.#allowlisted(tool, input)) {
      this.#emit('approval.resolved', { sessionId, requestId, approved: true, via: 'allowlist' })
      return Promise.resolve(true)
    }

    return new Promise<boolean>((resolve) => {
      this.#pending.set(requestId, {
        approval: { requestId, sessionId, tool, input },
        resolve,
      })
    })
  }

  pending(): PendingApproval[] {
    return [...this.#pending.values()].map((entry) => entry.approval)
  }

  resolve(requestId: string, approved: boolean): void {
    const entry = this.#pending.get(requestId)
    if (entry === undefined) {
      return
    }
    this.#pending.delete(requestId)
    this.#emit('approval.resolved', {
      sessionId: entry.approval.sessionId,
      requestId,
      approved,
      via: 'user',
    })
    entry.resolve(approved)
  }
}
