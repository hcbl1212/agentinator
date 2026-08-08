import { useEffect, useRef, useState } from 'react'

import type { PendingApproval } from '../../../shared/bridge'
import type { EventPayloads } from '../../../shared/events'
import { ApprovalCard } from './ApprovalCard'
import { ConversationLog } from './ConversationLog'
import { QuestionCard } from './QuestionCard'

type SessionStatus = 'running' | 'idle'

/**
 * The conversation column: a terminal-style transcript up top, then any active
 * decisions (the agent's question, pending approvals) as interactive cards, and
 * a roomy composer at the bottom. Enter sends; Shift+Enter inserts a newline.
 * Launching a task turns the composer into a reply box on that session, so the
 * whole column is one continuous conversation.
 */
export function Conversation(): React.JSX.Element {
  const bridge = window.agentinator
  const [prompt, setPrompt] = useState('')
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeRef = useRef<string | null>(null)
  const [status, setStatus] = useState<SessionStatus>('running')
  const [question, setQuestion] = useState<EventPayloads['agent.question'] | null>(null)

  useEffect(() => {
    const mounted = window.agentinator
    if (mounted === undefined) {
      return
    }
    let cancelled = false
    void mounted.approvals.pending().then((pending) => {
      if (!cancelled) {
        setApprovals(pending)
      }
    })
    const unsubscribe = mounted.events.onAppended((event) => {
      if (event.type === 'approval.requested') {
        const payload = event.payload as EventPayloads['approval.requested']
        setApprovals((previous) =>
          previous.some((approval) => approval.requestId === payload.requestId)
            ? previous
            : [...previous, payload],
        )
      } else if (event.type === 'approval.resolved') {
        const payload = event.payload as EventPayloads['approval.resolved']
        setApprovals((previous) =>
          previous.filter((approval) => approval.requestId !== payload.requestId),
        )
      } else if (event.type === 'session.idle') {
        const payload = event.payload as EventPayloads['session.idle']
        if (payload.sessionId === activeRef.current) {
          setStatus('idle')
        }
      } else if (event.type === 'agent.question') {
        const payload = event.payload as EventPayloads['agent.question']
        if (payload.sessionId === activeRef.current) {
          setQuestion(payload)
        }
      } else if (event.type === 'session.ended') {
        const payload = event.payload as EventPayloads['session.ended']
        if (payload.sessionId === activeRef.current) {
          activeRef.current = null
          setActiveSessionId(null)
          setQuestion(null)
        }
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const beginTask = (trimmed: string): void => {
    void bridge?.agent.startTask(trimmed).then((sessionId) => {
      activeRef.current = sessionId
      setActiveSessionId(sessionId)
      setStatus('running')
    })
  }

  const reply = (sessionId: string, trimmed: string): void => {
    void bridge?.agent.send(sessionId, trimmed)
    setStatus('running')
    setQuestion(null)
  }

  const submit = (): void => {
    const trimmed = prompt.trim()
    if (bridge === undefined || trimmed === '') {
      return
    }
    if (activeSessionId === null) {
      beginTask(trimmed)
    } else {
      reply(activeSessionId, trimmed)
    }
    setPrompt('')
  }

  const onSubmit = (submitEvent: React.FormEvent): void => {
    submitEvent.preventDefault()
    submit()
  }

  // Enter sends; Shift+Enter is a newline (the terminal-composer convention).
  const onKeyDown = (keyEvent: React.KeyboardEvent): void => {
    if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
      keyEvent.preventDefault()
      submit()
    }
  }

  const startNew = (sessionId: string): void => {
    void bridge?.agent.cancel(sessionId)
    activeRef.current = null
    setActiveSessionId(null)
    setQuestion(null)
  }

  const replying = activeSessionId !== null

  return (
    <section className="pane conversation" aria-label="Conversation">
      <div className="conversation-head">
        <h2 className="pane-label">Conversation</h2>
        {activeSessionId !== null && (
          <div className="session-status" aria-label="Active session">
            <span className={`status-dot ${status}`} aria-hidden="true" />
            <span className="session-status-label">
              {status === 'idle' ? 'Awaiting your reply' : 'Working…'}
            </span>
            <button
              type="button"
              className="new-task-button"
              onClick={() => startNew(activeSessionId)}
            >
              New task
            </button>
          </div>
        )}
      </div>

      <ConversationLog />

      {bridge === undefined ? (
        <p className="empty-state">Open a workspace to talk to an agent.</p>
      ) : (
        <div className="composer-dock">
          {question !== null && activeSessionId !== null && (
            <QuestionCard question={question} onAnswer={(text) => reply(activeSessionId, text)} />
          )}
          {approvals.length > 0 && (
            <div className="approvals" aria-label="Pending approvals">
              {approvals.map((approval) => (
                <ApprovalCard
                  key={approval.requestId}
                  approval={approval}
                  onResolve={(approved) =>
                    void bridge.approvals.resolve(approval.requestId, approved)
                  }
                  onUndo={() => void bridge.approvals.undo(approval.requestId)}
                />
              ))}
            </div>
          )}
          <form className="composer" onSubmit={onSubmit}>
            <textarea
              className="composer-input"
              aria-label={replying ? 'Reply to Claude' : 'Task for Claude'}
              placeholder={
                replying
                  ? 'Reply to the agent or steer it…  (Enter to send, Shift+Enter for a newline)'
                  : 'Describe a task for Claude to do in this repo…  (Enter to send)'
              }
              rows={3}
              value={prompt}
              onChange={(changed) => setPrompt(changed.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="composer-bar">
              {!replying && (
                <button
                  type="button"
                  className="demo-button"
                  onClick={() => void bridge.agent.startDemo()}
                >
                  ▶ Demo
                </button>
              )}
              <span className="composer-hint">↵ send · ⇧↵ newline</span>
              <button type="submit" className="run-task-button" disabled={prompt.trim() === ''}>
                {replying ? '➤ Send' : '▶ Run task'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
