import { useState } from 'react'

import type { EventPayloads } from '../../../shared/events'

interface QuestionCardProps {
  question: EventPayloads['agent.question']
  /** Answer the agent — the text is sent as the session's next message. */
  onAnswer: (text: string) => void
}

/**
 * The agent's own question rendered as an answerable card — option buttons for
 * the offered choices plus a free-text box. Answering sends a follow-up message
 * into the session, so this is a real reply, never a permission approval.
 */
export function QuestionCard({ question, onAnswer }: QuestionCardProps): React.JSX.Element {
  const [text, setText] = useState('')

  const submit = (submitEvent: React.FormEvent): void => {
    submitEvent.preventDefault()
    const trimmed = text.trim()
    if (trimmed === '') {
      return
    }
    onAnswer(trimmed)
    setText('')
  }

  return (
    <div className="question-card" aria-label="Agent question">
      <h2 className="pane-label">Agent is asking</h2>
      {question.questions.map((entry, index) => (
        <div key={`${index}-${entry.question}`} className="question-block">
          <p className="question-text">{entry.question}</p>
          {entry.options.length > 0 && (
            <div className="question-options">
              {entry.options.map((option) => (
                <button
                  key={`${index}-${option}`}
                  type="button"
                  className="question-option"
                  onClick={() => onAnswer(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <form className="question-reply" onSubmit={submit}>
        <input
          className="task-input"
          aria-label="Answer the agent"
          placeholder="Type an answer…"
          value={text}
          onChange={(changed) => setText(changed.target.value)}
        />
        <button type="submit" className="run-task-button" disabled={text.trim() === ''}>
          Send answer
        </button>
      </form>
    </div>
  )
}
