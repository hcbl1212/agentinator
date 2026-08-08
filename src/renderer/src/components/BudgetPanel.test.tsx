// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Budgets } from '../../../shared/budget'
import { BudgetPanel } from './BudgetPanel'

const budgets: Budgets = { session: 5, hour: null, day: 20, week: null, month: 200 }

describe('BudgetPanel', () => {
  it('renders a row per scope with the current cap', () => {
    render(<BudgetPanel budgets={budgets} onChange={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('spinbutton', { name: 'Session budget in dollars' })).toHaveValue(5)
    expect(screen.getByRole('spinbutton', { name: 'Day budget in dollars' })).toHaveValue(20)
    expect(screen.getByRole('spinbutton', { name: 'Hour budget in dollars' })).toHaveValue(null)
    expect(screen.getByRole('spinbutton', { name: 'Month budget in dollars' })).toHaveValue(200)
  })

  it('commits a positive number on Enter', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<BudgetPanel budgets={budgets} onChange={onChange} onClose={vi.fn()} />)

    const week = screen.getByRole('spinbutton', { name: 'Week budget in dollars' })
    await user.type(week, '50')
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith('week', 50)
  })

  it('clears a cap when the field is emptied', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<BudgetPanel budgets={budgets} onChange={onChange} onClose={vi.fn()} />)

    const day = screen.getByRole('spinbutton', { name: 'Day budget in dollars' })
    await user.clear(day)
    fireEvent.blur(day)

    expect(onChange).toHaveBeenCalledWith('day', null)
  })

  it('treats a non-positive value as clearing the cap', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<BudgetPanel budgets={budgets} onChange={onChange} onClose={vi.fn()} />)

    const session = screen.getByRole('spinbutton', { name: 'Session budget in dollars' })
    await user.clear(session)
    await user.type(session, '-3')
    fireEvent.blur(session)

    expect(onChange).toHaveBeenCalledWith('session', null)
  })

  it('closes via the close button', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<BudgetPanel budgets={budgets} onChange={vi.fn()} onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Close budgets' }))

    expect(onClose).toHaveBeenCalledOnce()
  })
})
