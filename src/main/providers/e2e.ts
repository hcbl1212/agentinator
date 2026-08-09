import type { AgentProvider, AgentSessionHandle, EmitEvent, PermissionDecider } from './types'
import type { SessionContext } from './types'

/**
 * A deterministic, no-network agent used only by the Playwright e2e (behind
 * AGENTINATOR_MOCK_TASKS). Unlike the scripted greet mock it is multi-turn —
 * it goes idle and answers follow-ups — and it exercises the paths the e2e
 * guards: it emits a diff, reports cost (so a low budget can stop it), and, when
 * the prompt mentions "approval", requests a permission so an approval card
 * appears. Every emit lands after the manager registers the handle (a
 * microtask), so budget cancellation is enforced.
 */
export function createE2eProvider(decide: PermissionDecider): AgentProvider {
  return {
    id: 'e2e',
    label: 'E2E',
    capabilities: {
      vision: false,
      toolUse: true,
      streaming: true,
      promptCaching: false,
      taskBudgets: false,
      batchApi: false,
      nativeSkills: false,
      meteredAuth: false,
      contextWindowTokens: 200_000,
    },
    startSession(context: SessionContext, emit: EmitEvent): AgentSessionHandle {
      const { sessionId } = context
      let cancelled = false

      const run = async (): Promise<void> => {
        // Synchronous so it lands before the manager logs the opening prompt.
        emit('session.started', {
          sessionId,
          agentId: context.agentId,
          workspaceId: context.workspaceId,
          title: context.title,
        })
        // Yield so the handle is registered before the budget-bearing events.
        await Promise.resolve()
        emit('agent.text', { sessionId, text: 'Ready.' })
        emit('file.diffed', {
          sessionId,
          path: 'src/demo/e2e.ts',
          additions: 2,
          deletions: 0,
          patch: '+export const answer = 42\n+export const other = 7',
        })
        emit('cost.usage', {
          sessionId,
          inputTokens: 10,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          usd: 0.1,
        })
        if (cancelled) {
          return
        }
        if (context.prompt.toLowerCase().includes('approval')) {
          const approved = await decide(sessionId, 'write', { path: 'src/demo/danger.ts' })
          if (cancelled) {
            return
          }
          emit('agent.text', { sessionId, text: approved ? 'Write approved.' : 'Write denied.' })
        }
        emit('session.idle', { sessionId })
      }
      void run()

      return {
        send: (text) => {
          emit('agent.text', { sessionId, text: `Echo: ${text}` })
          emit('session.idle', { sessionId })
          return Promise.resolve()
        },
        cancel: () => {
          cancelled = true
          emit('session.ended', { sessionId, outcome: 'cancelled' })
          return Promise.resolve()
        },
      }
    },
  }
}
