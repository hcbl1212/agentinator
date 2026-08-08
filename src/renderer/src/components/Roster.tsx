import { useEffect, useRef, useState } from 'react'

import type { PendingApproval } from '../../../shared/bridge'
import type { EventPayloads } from '../../../shared/events'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'

type SessionStatus = 'running' | 'idle'

export function Roster(): React.JSX.Element {
  const bridge = window.agentinator
  const [prompt, setPrompt] = useState('')
  const [dispatched, setDispatched] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  // The ongoing conversation: a task launched from here that hasn't ended.
  // The ref mirrors the state so the once-mounted event listener can compare
  // incoming session ids without re-subscribing on every change.
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
    setDispatched('Task dispatched to Claude — watch it work in the timeline.')
  }

  const reply = (sessionId: string, trimmed: string): void => {
    void bridge?.agent.send(sessionId, trimmed)
    setStatus('running')
    setQuestion(null)
  }

  const runTask = (submitEvent: React.FormEvent): void => {
    submitEvent.preventDefault()
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

  const startNew = (sessionId: string): void => {
    void bridge?.agent.cancel(sessionId)
    activeRef.current = null
    setActiveSessionId(null)
    setQuestion(null)
    setDispatched(null)
  }

  const replying = activeSessionId !== null

  return (
    <aside className="pane roster" aria-label="Agent roster">
      <h2 className="pane-label">Agents</h2>
      {bridge === undefined ? (
        <p className="empty-state">No agents yet.</p>
      ) : (
        <>
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
          <form className="task-launcher" onSubmit={runTask}>
            <textarea
              className="task-input"
              aria-label={replying ? 'Reply to Claude' : 'Task for Claude'}
              placeholder={
                replying
                  ? 'Reply to the agent or steer it…'
                  : 'Describe a task for Claude to do in this repo…'
              }
              rows={3}
              value={prompt}
              onChange={(changed) => setPrompt(changed.target.value)}
            />
            <button type="submit" className="run-task-button" disabled={prompt.trim() === ''}>
              {replying ? '➤ Send reply' : '▶ Run task (Claude)'}
            </button>
          </form>
          {!replying && (
            <button
              type="button"
              className="demo-button"
              onClick={() => {
                setDispatched('Demo dispatched — watch the log count in the status bar.')
                void bridge.agent.startDemo()
              }}
            >
              ▶ Run demo (mock)
            </button>
          )}
        </>
      )}
      {question !== null && activeSessionId !== null && (
        <QuestionCard question={question} onAnswer={(text) => reply(activeSessionId, text)} />
      )}
      {dispatched !== null && <p className="empty-state">{dispatched}</p>}
      {approvals.length > 0 && (
        <div className="approvals" aria-label="Pending approvals">
          <h2 className="pane-label">Needs approval</h2>
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.requestId}
              approval={approval}
              onResolve={(approved) => void bridge?.approvals.resolve(approval.requestId, approved)}
              onUndo={() => void bridge?.approvals.undo(approval.requestId)}
            />
          ))}
        </div>
      )}
    </aside>
  )
}
