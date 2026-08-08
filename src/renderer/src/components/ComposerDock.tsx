import { useEffect, useRef, useState } from 'react'

import type { PendingApproval } from '../../../shared/bridge'
import type { EventPayloads, ImageAttachment } from '../../../shared/events'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'

type SessionStatus = 'running' | 'idle'

/** A screenshot pasted into the composer: a thumbnail plus the base64 payload
 * sent to the model. */
interface PastedImage {
  id: string
  dataUrl: string
  mediaType: string
  data: string
}

/**
 * The bottom of the stream: active decisions (the agent's question, pending
 * approvals) as interactive cards, then a roomy composer. Enter sends;
 * Shift+Enter is a newline. Launching a task turns the composer into a reply
 * box on that session, so the stream above stays one continuous conversation.
 */
export function ComposerDock(): React.JSX.Element {
  const bridge = window.agentinator
  const [prompt, setPrompt] = useState('')
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeRef = useRef<string | null>(null)
  const [status, setStatus] = useState<SessionStatus>('running')
  const [question, setQuestion] = useState<EventPayloads['agent.question'] | null>(null)
  // The vendor/model behind the prompt — reflected in the UI, never hardcoded.
  const [agentLabel, setAgentLabel] = useState<string | null>(null)
  const [images, setImages] = useState<PastedImage[]>([])

  useEffect(() => {
    const mounted = window.agentinator
    if (mounted === undefined) {
      return
    }
    let cancelled = false
    void mounted.agent.current().then((agent) => {
      if (!cancelled) {
        setAgentLabel(agent.label)
      }
    })
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

  const beginTask = (trimmed: string, attachments: ImageAttachment[]): void => {
    void bridge?.agent.startTask(trimmed, attachments).then((sessionId) => {
      activeRef.current = sessionId
      setActiveSessionId(sessionId)
      setStatus('running')
    })
  }

  const reply = (sessionId: string, trimmed: string, attachments: ImageAttachment[]): void => {
    void bridge?.agent.send(sessionId, trimmed, attachments)
    setStatus('running')
    setQuestion(null)
  }

  const submit = (): void => {
    const trimmed = prompt.trim()
    // A screenshot with no words is still worth sending.
    if (bridge === undefined || (trimmed === '' && images.length === 0)) {
      return
    }
    const attachments = images.map(({ mediaType, data }) => ({ mediaType, data }))
    if (activeSessionId === null) {
      beginTask(trimmed, attachments)
    } else {
      reply(activeSessionId, trimmed, attachments)
    }
    setPrompt('')
    setImages([])
  }

  // Capture pasted images as attachments (kept out of the text field).
  const onPaste = (pasteEvent: React.ClipboardEvent): void => {
    const files = Array.from(pasteEvent.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) {
      return
    }
    pasteEvent.preventDefault()
    for (const file of files) {
      const reader = new FileReader()
      reader.onload = (): void => {
        const dataUrl = String(reader.result)
        setImages((previous) => [
          ...previous,
          {
            id: crypto.randomUUID(),
            dataUrl,
            mediaType: dataUrl.slice(5, dataUrl.indexOf(';')),
            data: dataUrl.slice(dataUrl.indexOf(',') + 1),
          },
        ])
      }
      reader.readAsDataURL(file)
    }
  }

  const removeImage = (id: string): void => {
    setImages((previous) => previous.filter((image) => image.id !== id))
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
  const who = agentLabel ?? 'the agent'

  return (
    <div className="composer-dock" aria-label="Composer">
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

      {bridge === undefined ? (
        <p className="empty-state">Open a workspace to talk to an agent.</p>
      ) : (
        <>
          {question !== null && activeSessionId !== null && (
            <QuestionCard
              question={question}
              onAnswer={(text) => reply(activeSessionId, text, [])}
            />
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
          {images.length > 0 && (
            <div className="paste-thumbs" aria-label="Pasted images">
              {images.map((image) => (
                <span key={image.id} className="paste-thumb">
                  <img src={image.dataUrl} alt="pasted screenshot" />
                  <button
                    type="button"
                    className="paste-thumb-remove"
                    aria-label="Remove image"
                    onClick={() => removeImage(image.id)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="console">
            <span className="console-prompt" aria-hidden="true">
              {agentLabel !== null && <span className="console-agent">{agentLabel}</span>} &gt;
            </span>
            <textarea
              className="console-input"
              aria-label={replying ? 'Reply to the agent' : 'Task for the agent'}
              placeholder={
                replying
                  ? `Reply to ${who} or steer it…  (Enter to send, Shift+Enter for a newline)`
                  : `Describe a task for ${who} to do in this repo…  (paste a screenshot too)`
              }
              rows={1}
              value={prompt}
              onChange={(changed) => setPrompt(changed.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
          </div>
        </>
      )}
    </div>
  )
}
