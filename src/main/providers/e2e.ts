import type { AgentProvider, AgentSessionHandle, EmitEvent, PermissionDecider } from './types'
import type { SessionContext } from './types'

/**
 * A deterministic, no-network agent used only by the Playwright e2e (behind
 * AGENTINATOR_MOCK_TASKS). Unlike the scripted greet mock it is multi-turn —
 * it goes idle and answers follow-ups — and it is a FAITHFUL MIRROR of the real
 * adapter's event vocabulary (the parity contract, providers/contract.ts): every
 * turn reports which model/credential it ran on and a resume token, thinks,
 * makes a tool call, emits a diff, and reports cost. Trigger words drive the
 * conditional paths: "approval" requests a permission, "question" asks the user.
 * Every emit after session.started lands post-handle-registration (a microtask),
 * so budget cancellation is enforced.
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
        // The internal plumbing a real turn reports (hidden from the timeline,
        // but the rail/parity depend on it): credential, resume token, model.
        emit('session.resumable', { sessionId, resumeToken: `e2e-${sessionId}` })
        emit('session.auth', { sessionId, source: 'none' })
        emit('session.model', { sessionId, model: 'e2e-model-1' })
        emit('agent.thinking', { sessionId, summary: 'Planning the change.' })
        // A read tool call the timeline renders (auto-allowed, no approval).
        emit('tool.called', {
          sessionId,
          callId: 'call_1',
          tool: 'read',
          input: { path: 'README.md' },
        })
        emit('tool.resulted', { sessionId, callId: 'call_1', ok: true, output: 'read 12 lines' })
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
        // The agent asks the user to choose — an answerable question card.
        if (context.prompt.toLowerCase().includes('question')) {
          emit('agent.question', {
            sessionId,
            requestId: `ask_${sessionId}`,
            questions: [{ question: 'Which approach?', options: ['Fast', 'Safe'] }],
          })
          emit('session.idle', { sessionId })
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
      // On resume (reopened after a restart) the opening turn is skipped, like
      // the real adapter — the reply arrives via send().
      if (context.resume === undefined) {
        void run()
      }

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
