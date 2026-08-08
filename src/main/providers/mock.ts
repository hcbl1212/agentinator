import type { AgentProvider, AgentSessionHandle, EmitEvent, SessionContext } from './types'

export type Sleep = (ms: number) => Promise<void>

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * A deterministic, scripted agent session. Drives every provider-layer test
 * and the in-app demo — no API key, no network, same events every time.
 */
export function createMockProvider(sleep: Sleep = defaultSleep, stepMs = 250): AgentProvider {
  return {
    id: 'mock',
    capabilities: {
      vision: false,
      toolUse: true,
      streaming: true,
      promptCaching: false,
      taskBudgets: false,
      batchApi: false,
      nativeSkills: false,
      contextWindowTokens: 200_000,
    },
    startSession(context: SessionContext, emit: EmitEvent): AgentSessionHandle {
      let cancelled = false

      const run = async (): Promise<void> => {
        const { sessionId } = context
        emit('session.started', {
          sessionId,
          agentId: context.agentId,
          workspaceId: context.workspaceId,
          title: context.title,
        })

        const steps: Array<() => void> = [
          () =>
            emit('agent.thinking', {
              sessionId,
              summary: 'Planning: add a greet() util with a colocated test.',
            }),
          () =>
            emit('agent.text', {
              sessionId,
              text: 'Adding src/demo/greet.ts with a test, then running the suite.',
            }),
          () =>
            emit('tool.called', {
              sessionId,
              callId: 'call_1',
              tool: 'write',
              input: { path: 'src/demo/greet.ts' },
            }),
          () =>
            emit('tool.resulted', {
              sessionId,
              callId: 'call_1',
              ok: true,
              output: 'wrote src/demo/greet.ts',
            }),
          () =>
            emit('file.diffed', {
              sessionId,
              path: 'src/demo/greet.ts',
              additions: 3,
              deletions: 0,
              patch:
                '+export function greet(name: string): string {\n+  return `hello ${name}`\n+}',
            }),
          () =>
            emit('tool.called', {
              sessionId,
              callId: 'call_2',
              tool: 'bash',
              input: { command: 'npm test' },
            }),
          () =>
            emit('tool.resulted', {
              sessionId,
              callId: 'call_2',
              ok: true,
              output: 'Tests passed.',
            }),
          () =>
            emit('cost.usage', {
              sessionId,
              inputTokens: 1200,
              outputTokens: 340,
              cacheReadInputTokens: 900,
              usd: 0.0042,
            }),
        ]

        for (const step of steps) {
          await sleep(stepMs)
          if (cancelled) {
            emit('session.ended', { sessionId, outcome: 'cancelled' })
            return
          }
          step()
        }

        await sleep(stepMs)
        emit('session.ended', { sessionId, outcome: cancelled ? 'cancelled' : 'completed' })
      }

      void run()

      return {
        send: () => Promise.reject(new Error('The mock provider does not support steering.')),
        cancel: () => {
          cancelled = true
          return Promise.resolve()
        },
      }
    },
  }
}
