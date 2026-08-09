import { useEffect, useRef, useState } from 'react'

import type { PendingApproval } from '../../../shared/bridge'
import type { EventPayloads, ImageAttachment } from '../../../shared/events'
import { useSelection } from '../state/selection'
import { useSessions } from '../state/sessions'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'

/** A screenshot pasted/dropped into the composer: a thumbnail plus the base64
 * payload sent to the model. */
interface PastedImage {
  id: string
  dataUrl: string
  mediaType: string
  data: string
}

/**
 * The bottom of the stream. It follows the highlighted agent: when one is
 * selected, the composer replies to it (and shows its status and any pending
 * question); with none selected it launches a fresh agent and selects it. The
 * rail's "New agent" clears the selection to start over. Enter sends;
 * Shift+Enter is a newline; images can be pasted or dropped.
 */
export function ComposerDock(): React.JSX.Element {
  const bridge = window.agentinator
  const { sessions } = useSessions()
  const { selection, select, clear } = useSelection()
  const [prompt, setPrompt] = useState('')
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [questions, setQuestions] = useState<Record<string, EventPayloads['agent.question']>>({})
  const [images, setImages] = useState<PastedImage[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const selectedId = selection?.kind === 'session' ? selection.id : null
  const selected = sessions.find((session) => session.id === selectedId)
  const replying = selected !== undefined
  const question = selectedId === null ? undefined : questions[selectedId]

  // Focus the prompt whenever it's ready for a new task (on load and when the
  // rail's "New agent" deselects) so you can just start typing.
  useEffect(() => {
    if (!replying) {
      inputRef.current?.focus()
    }
  }, [replying])

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
      } else if (event.type === 'agent.question') {
        const payload = event.payload as EventPayloads['agent.question']
        setQuestions((previous) => ({ ...previous, [payload.sessionId]: payload }))
      } else if (event.type === 'session.ended') {
        const payload = event.payload as EventPayloads['session.ended']
        setQuestions((previous) => {
          const rest = { ...previous }
          delete rest[payload.sessionId]
          return rest
        })
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const clearQuestion = (sessionId: string): void => {
    setQuestions((previous) => {
      const rest = { ...previous }
      delete rest[sessionId]
      return rest
    })
  }

  const sendMessage = (sessionId: string, text: string, attachments: ImageAttachment[]): void => {
    void bridge?.agent.send(sessionId, text, attachments)
    clearQuestion(sessionId)
  }

  const submit = (): void => {
    const trimmed = prompt.trim()
    // "/clear" drops the current agent and starts a fresh prompt.
    if (trimmed === '/clear') {
      clear()
      setPrompt('')
      setImages([])
      return
    }
    // A screenshot with no words is still worth sending.
    if (bridge === undefined || (trimmed === '' && images.length === 0)) {
      return
    }
    const attachments = images.map(({ mediaType, data }) => ({ mediaType, data }))
    if (selected !== undefined) {
      sendMessage(selected.id, trimmed, attachments)
    } else {
      void bridge.agent.startTask(trimmed, attachments).then((id) => {
        select({ kind: 'session', id })
      })
    }
    setPrompt('')
    setImages([])
  }

  const addImageFiles = (files: File[]): void => {
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

  // Images arrive two ways: pasted (clipboard items) or dropped/copied as
  // files. Prefer items, fall back to the file list.
  const imageFilesFrom = (data: DataTransfer): File[] => {
    const fromItems = Array.from(data.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    return fromItems.length > 0
      ? fromItems
      : Array.from(data.files).filter((file) => file.type.startsWith('image/'))
  }

  const onPaste = (pasteEvent: React.ClipboardEvent): void => {
    const files = imageFilesFrom(pasteEvent.clipboardData)
    if (files.length === 0) {
      return
    }
    pasteEvent.preventDefault()
    addImageFiles(files)
  }

  const onDrop = (dropEvent: React.DragEvent): void => {
    const files = imageFilesFrom(dropEvent.dataTransfer)
    if (files.length === 0) {
      return
    }
    dropEvent.preventDefault()
    addImageFiles(files)
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

  return (
    <div
      className="composer-dock"
      aria-label="Composer"
      onDrop={onDrop}
      onDragOver={(dragEvent) => dragEvent.preventDefault()}
    >
      {selected !== undefined && (
        <div className="session-status" aria-label="Active session">
          <span className={`status-dot ${selected.status}`} aria-hidden="true" />
          <span className="session-status-label">
            {selected.status === 'idle' ? 'Awaiting your reply' : 'Working…'} · {selected.title}
          </span>
        </div>
      )}

      {bridge === undefined ? (
        <p className="empty-state">Open a workspace to talk to an agent.</p>
      ) : (
        <>
          {question !== undefined && selected !== undefined && (
            <QuestionCard
              question={question}
              onAnswer={(text) => sendMessage(selected.id, text, [])}
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
              &gt;
            </span>
            <textarea
              ref={inputRef}
              className="console-input"
              aria-label={replying ? 'Reply to the agent' : 'Task for the agent'}
              placeholder={
                replying ? 'Reply to the agent or steer it…' : 'Describe a task for the agent…'
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
