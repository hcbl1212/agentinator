import type {
  AgentProvider,
  AgentSessionHandle,
  EmitEvent,
  PermissionDecider,
  SessionContext,
} from './types'

export type Sleep = (ms: number) => Promise<void>

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const allowAll: PermissionDecider = () => Promise.resolve(true)

class SessionCancelled extends Error {}

/**
 * A deterministic, scripted agent session. Drives every provider-layer test
 * and the in-app demo — no API key, no network, same events every time.
 * Requests permission like a real provider would: the write is user-gated
 * (a blocking card in the app), the test run matches the allowlist.
 */
export function createMockProvider(
  sleep: Sleep = defaultSleep,
  stepMs = 250,
  decide: PermissionDecider = allowAll,
): AgentProvider {
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
      const { sessionId } = context

      const step = async (emitOne: () => void): Promise<void> => {
        await sleep(stepMs)
        if (cancelled) {
          throw new SessionCancelled()
        }
        emitOne()
      }

      const run = async (): Promise<void> => {
        emit('session.started', {
          sessionId,
          agentId: context.agentId,
          workspaceId: context.workspaceId,
          title: context.title,
        })

        try {
          await step(() =>
            emit('agent.thinking', {
              sessionId,
              summary: 'Planning: add a greet() util with a colocated test.',
            }),
          )
          await step(() =>
            emit('agent.text', {
              sessionId,
              text: 'Adding src/demo/greet.ts with a test, then running the suite.',
            }),
          )

          await sleep(stepMs)
          if (cancelled) {
            throw new SessionCancelled()
          }
          const writeApproved = await decide(sessionId, 'write', { path: 'src/demo/greet.ts' })
          if (writeApproved) {
            emit('tool.called', {
              sessionId,
              callId: 'call_1',
              tool: 'write',
              input: { path: 'src/demo/greet.ts' },
            })
            await step(() =>
              emit('tool.resulted', {
                sessionId,
                callId: 'call_1',
                ok: true,
                output: 'wrote src/demo/greet.ts',
              }),
            )
            await step(() =>
              emit('file.diffed', {
                sessionId,
                path: 'src/demo/greet.ts',
                additions: 3,
                deletions: 0,
                patch:
                  '+export function greet(name: string): string {\n+  return `hello ${name}`\n+}',
              }),
            )
          } else {
            emit('agent.text', { sessionId, text: 'Write denied — skipping the change.' })
          }

          await sleep(stepMs)
          if (cancelled) {
            throw new SessionCancelled()
          }
          const testApproved = await decide(sessionId, 'bash', { command: 'npm test' })
          if (testApproved) {
            emit('tool.called', {
              sessionId,
              callId: 'call_2',
              tool: 'bash',
              input: { command: 'npm test' },
            })
            await step(() =>
              emit('tool.resulted', {
                sessionId,
                callId: 'call_2',
                ok: true,
                output: 'Tests passed.',
              }),
            )
          } else {
            emit('agent.text', { sessionId, text: 'Test run denied.' })
          }

          await step(() =>
            emit('cost.usage', {
              sessionId,
              inputTokens: 1200,
              outputTokens: 340,
              cacheReadInputTokens: 900,
              usd: 0.0042,
            }),
          )

          await sleep(stepMs)
          emit('session.ended', { sessionId, outcome: cancelled ? 'cancelled' : 'completed' })
        } catch {
          emit('session.ended', { sessionId, outcome: 'cancelled' })
        }
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
