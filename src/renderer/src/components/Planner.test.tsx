// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, PlanTaskSpec, StoredEvent } from '../../../shared/events'
import { PlanProvider, usePlans } from '../state/plans'
import type { PlanTaskView } from '../state/plans'
import { SelectionProvider, useSelection } from '../state/selection'
import { Planner, taskDepth } from './Planner'

function stub(backfill: StoredEvent[] = []): {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  create: ReturnType<typeof vi.fn>
  dispatch: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  let appended: (event: StoredEvent) => void = () => undefined
  const create = vi.fn(() => Promise.resolve('plan_new'))
  const dispatch = vi.fn(() => Promise.resolve('sess_new'))
  const remove = vi.fn(() => Promise.resolve())
  return {
    emit: (event) => appended(event),
    create,
    dispatch,
    remove,
    bridge: {
      events: {
        tail: vi.fn(() => Promise.resolve(backfill)),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
      planner: { create, dispatch, remove },
    } as unknown as AgentinatorBridge,
  }
}

function event<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq: 1, ts: 't', type, payload }
}

const TASKS: PlanTaskSpec[] = [
  { taskId: 'ta', title: 'Scaffold', prompt: 'a', dependsOn: [] },
  { taskId: 'tb', title: 'Implement', prompt: 'b', dependsOn: ['ta'] },
  { taskId: 'tc', title: 'Verify', prompt: 'c', dependsOn: ['ta', 'tb'] },
]

function created(planId: string, title = 'Settings page'): StoredEvent {
  return event('plan.created', { planId, title, requirement: 'Add a settings page', tasks: TASKS })
}

function renderPlanner(): void {
  render(
    <SelectionProvider>
      <PlanProvider>
        <Planner />
      </PlanProvider>
    </SelectionProvider>,
  )
}

afterEach(() => {
  delete window.agentinator
})

describe('taskDepth', () => {
  const view = (id: string, dependsOn: string[]): PlanTaskView => ({
    id,
    title: id,
    prompt: `do ${id}`,
    dependsOn,
    status: 'pending',
  })

  it('is the longest dependency chain below the task', () => {
    const tasks = [view('a', []), view('b', ['a']), view('c', ['a', 'b'])]
    const byId = new Map(tasks.map((task) => [task.id, task]))

    expect(taskDepth(tasks[0], byId)).toBe(0)
    expect(taskDepth(tasks[1], byId)).toBe(1)
    expect(taskDepth(tasks[2], byId)).toBe(2)
  })

  it('treats unknown dependencies as depth 0 and survives a cycle', () => {
    const ghost = view('g', ['nope'])
    expect(taskDepth(ghost, new Map([['g', ghost]]))).toBe(0)

    // A cycle can only come from a hand-built log — it must not hang.
    const a = view('a', ['b'])
    const b = view('b', ['a'])
    const byId = new Map([
      ['a', a],
      ['b', b],
    ])
    expect(taskDepth(a, byId)).toBeLessThanOrEqual(2)
  })
})

describe('Planner', () => {
  it('shows the empty state with no plans (and without a bridge)', () => {
    renderPlanner() // no window.agentinator — the provider effect returns early
    expect(screen.getByText(/No plans yet/)).toBeInTheDocument()
  })

  it('plans a requirement: busy while decomposing, cleared when it lands', async () => {
    const s = stub()
    let resolve: (id: string) => void = () => undefined
    s.create.mockReturnValueOnce(
      new Promise<string>((r) => {
        resolve = r
      }),
    )
    window.agentinator = s.bridge
    renderPlanner()

    const input = screen.getByRole('textbox', { name: 'Requirement to plan' })
    // An empty requirement does nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(s.create).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'Add a settings page' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(s.create).toHaveBeenCalledWith('Add a settings page')

    // While the AI decomposes, the form is busy and can't double-submit.
    const busy = screen.getByRole('button', { name: 'Planning…' })
    expect(busy).toBeDisabled()
    fireEvent.submit(busy.closest('form') as HTMLFormElement)
    expect(s.create).toHaveBeenCalledOnce()

    await act(async () => {
      resolve('plan_new')
      await Promise.resolve()
    })
    expect(input).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Plan' })).toBeEnabled()
  })

  it('keeps the requirement text when decomposition fails, freeing the button', async () => {
    const s = stub()
    s.create.mockReturnValueOnce(Promise.reject(new Error('provider down')))
    window.agentinator = s.bridge
    renderPlanner()

    const input = screen.getByRole('textbox', { name: 'Requirement to plan' })
    fireEvent.change(input, { target: { value: 'Add a settings page' } })
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(input).toHaveValue('Add a settings page')
    expect(screen.getByRole('button', { name: 'Plan' })).toBeEnabled()
  })

  it('backfills a plan as a tree with a ready frontier and blocked dependents', async () => {
    window.agentinator = stub([created('pl1')]).bridge

    renderPlanner()

    expect(await screen.findByText('Settings page')).toBeInTheDocument()
    expect(screen.getByLabelText('Scaffold — ready')).toBeInTheDocument()
    expect(screen.getByLabelText('Implement — blocked · after Scaffold')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Verify — blocked · after Scaffold, Implement'),
    ).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    // Only the frontier is dispatchable.
    expect(screen.getByRole('button', { name: 'Dispatch Scaffold' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dispatch Implement' })).not.toBeInTheDocument()
    // The tree indents by dependency depth.
    expect(screen.getByLabelText('Scaffold — ready').closest('li')).toHaveStyle({
      paddingLeft: '0px',
    })
    expect(screen.getByLabelText('Implement — blocked · after Scaffold').closest('li')).toHaveStyle(
      { paddingLeft: '14px' },
    )
  })

  it('dispatches a ready task and selects its new agent', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    let selection: unknown
    function Probe(): null {
      selection = useSelection().selection
      return null
    }
    render(
      <SelectionProvider>
        <PlanProvider>
          <Probe />
          <Planner />
        </PlanProvider>
      </SelectionProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch Scaffold' }))
    expect(s.dispatch).toHaveBeenCalledWith('pl1', 'ta')
    await act(async () => {
      await Promise.resolve()
    })
    expect(selection).toEqual({ kind: 'session', id: 'sess_new' })
  })

  it('leaves the selection alone when the dispatch was refused', async () => {
    const s = stub([created('pl1')])
    s.dispatch.mockReturnValueOnce(Promise.resolve(null))
    window.agentinator = s.bridge
    let selection: unknown
    function Probe(): null {
      selection = useSelection().selection
      return null
    }
    render(
      <SelectionProvider>
        <PlanProvider>
          <Probe />
          <Planner />
        </PlanProvider>
      </SelectionProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch Scaffold' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(selection).toBeNull()
  })

  it('follows a task through running and done, unlocking its dependents', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPlanner()

    act(() => {
      s.emit(created('pl1'))
      s.emit(created('pl1')) // dupe ignored
      s.emit(event('plan.task.dispatched', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
    })
    // Running: the chip follows its agent; the dispatch button is gone.
    expect(
      screen.getByRole('button', { name: 'Scaffold — running — select its agent' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dispatch Scaffold' })).not.toBeInTheDocument()

    act(() => {
      s.emit(event('plan.task.completed', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
    })
    // Done → Implement joins the frontier; Verify still waits on it.
    expect(
      screen.getByRole('button', { name: 'Scaffold — done — select its agent' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dispatch Implement' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dispatch Verify' })).not.toBeInTheDocument()
  })

  it('selects the plan itself from its title (opening the canvas via focus-follows)', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    let selection: unknown
    function Probe(): null {
      selection = useSelection().selection
      return null
    }
    render(
      <SelectionProvider>
        <PlanProvider>
          <Probe />
          <Planner />
        </PlanProvider>
      </SelectionProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Select plan Settings page' }))

    expect(selection).toEqual({ kind: 'plan', id: 'pl1' })
  })

  it('selects a launched task’s agent on click', () => {
    const s = stub()
    window.agentinator = s.bridge
    let selection: unknown
    function Probe(): null {
      selection = useSelection().selection
      return null
    }
    render(
      <SelectionProvider>
        <PlanProvider>
          <Probe />
          <Planner />
        </PlanProvider>
      </SelectionProvider>,
    )

    act(() => {
      s.emit(created('pl1'))
      s.emit(event('plan.task.dispatched', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Scaffold — running — select its agent' }))

    expect(selection).toEqual({ kind: 'session', id: 's0' })
  })

  it('returns a failed task to the frontier for a retry', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPlanner()

    act(() => {
      s.emit(created('pl1'))
      s.emit(event('plan.task.dispatched', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
      s.emit(event('plan.task.failed', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
    })

    expect(
      screen.getByRole('button', { name: 'Scaffold — failed — select its agent' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dispatch Scaffold' })).toBeInTheDocument()
  })

  it('clears a plan via its remove button, and folds out a removed one', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPlanner()

    act(() => {
      s.emit(created('pl1', 'First'))
      s.emit(created('pl2', 'Second'))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Clear plan First' }))
    expect(s.remove).toHaveBeenCalledWith('pl1')

    act(() => {
      s.emit(event('plan.removed', { planId: 'pl1' }))
    })
    expect(screen.queryByText('First')).not.toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
  })

  it('ignores task events for an unknown plan', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderPlanner()

    act(() => {
      s.emit(created('pl1'))
      s.emit(event('plan.task.dispatched', { planId: 'ghost', taskId: 'ta', sessionId: 'g' }))
      s.emit(event('agent.text', { sessionId: 'x', text: 'noise' })) // unrelated
    })

    expect(screen.getByLabelText('Scaffold — ready')).toBeInTheDocument()
  })

  it('ignores a backfill that resolves after unmount', async () => {
    window.agentinator = stub([created('pl1')]).bridge
    const { unmount } = render(
      <SelectionProvider>
        <PlanProvider>
          <Planner />
        </PlanProvider>
      </SelectionProvider>,
    )
    unmount()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('throws if usePlans is used outside a provider', () => {
    expect(() => renderHook(() => usePlans())).toThrow('within a PlanProvider')
  })
})
