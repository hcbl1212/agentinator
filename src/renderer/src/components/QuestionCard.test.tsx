// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { EventPayloads } from '../../../shared/events'
import { QuestionCard } from './QuestionCard'

function question(
  questions: EventPayloads['agent.question']['questions'],
): EventPayloads['agent.question'] {
  return { sessionId: 's', requestId: 'approval_q', questions }
}

describe('QuestionCard', () => {
  it('answers with an option label when a choice button is clicked', async () => {
    const onAnswer = vi.fn()
    render(
      <QuestionCard
        question={question([{ question: 'Which approach?', options: ['Continue', 'Restart'] }])}
        onAnswer={onAnswer}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))

    expect(onAnswer).toHaveBeenCalledWith('Restart')
  })

  it('answers with free text and clears the field, ignoring blank submissions', async () => {
    const onAnswer = vi.fn()
    render(
      <QuestionCard
        question={question([{ question: 'What next?', options: [] }])}
        onAnswer={onAnswer}
      />,
    )

    const field = screen.getByRole('textbox', { name: 'Answer the agent' })
    const send = screen.getByRole('button', { name: 'Send answer' })

    // Blank is a no-op: the button is disabled, and a direct form submit bails.
    expect(send).toBeDisabled()
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    expect(onAnswer).not.toHaveBeenCalled()

    await userEvent.type(field, 'ship the smaller change')
    await userEvent.click(send)

    expect(onAnswer).toHaveBeenCalledWith('ship the smaller change')
    expect(field).toHaveValue('')
  })

  it('renders a question with no options as text only', () => {
    render(
      <QuestionCard
        question={question([{ question: 'Anything to add?', options: [] }])}
        onAnswer={vi.fn()}
      />,
    )

    expect(screen.getByText('Anything to add?')).toBeInTheDocument()
    // No option buttons — only the free-text submit remains.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
