// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentType } from '../../../shared/agentTypes'
import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, PlanTaskSpec, StoredEvent } from '../../../shared/events'
import { AgentTypesProvider } from '../state/agentTypes'
import { PlanProvider } from '../state/plans'
import type { PlanTaskView } from '../state/plans'
import { SelectionProvider, useSelection } from '../state/selection'
import { chainOf, layoutNodes, PlanCanvas } from './PlanCanvas'

const SAVED_TYPES: AgentType[] = [
  { id: 'at_rev', name: 'Reviewer', instructions: 'review' },
  { id: 'at_doc', name: 'Doc writer', instructions: 'write docs' },
]

function stub(
  backfill: StoredEvent[] = [],
  types: AgentType[] = SAVED_TYPES,
): {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  dispatch: ReturnType<typeof vi.fn>
  addEdge: ReturnType<typeof vi.fn>
  removeEdge: ReturnType<typeof vi.fn>
  retype: ReturnType<typeof vi.fn>
  reprompt: ReturnType<typeof vi.fn>
} {
  let appended: (event: StoredEvent) => void = () => undefined
  const dispatch = vi.fn(() => Promise.resolve('sess_new'))
  const addEdge = vi.fn(() => Promise.resolve(true))
  const removeEdge = vi.fn(() => Promise.resolve(true))
  const retype = vi.fn(() => Promise.resolve(true))
  const reprompt = vi.fn(() => Promise.resolve(true))
  return {
    emit: (event) => appended(event),
    dispatch,
    addEdge,
    removeEdge,
    retype,
    reprompt,
    bridge: {
      events: {
        tail: vi.fn(() => Promise.resolve(backfill)),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
      agentTypes: { list: vi.fn(() => Promise.resolve(types)) },
      planner: {
        create: vi.fn(),
        dispatch,
        remove: vi.fn(),
        addEdge,
        removeEdge,
        retype,
        reprompt,
      },
    } as unknown as AgentinatorBridge,
  }
}

function event<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq: 1, ts: 't', type, payload }
}

const TASKS: PlanTaskSpec[] = [
  { taskId: 'ta', title: 'Scaffold', prompt: 'brief: scaffold it', dependsOn: [] },
  { taskId: 'tb', title: 'Implement', prompt: 'brief: implement it', dependsOn: ['ta'] },
  { taskId: 'tc', title: 'Verify', prompt: 'brief: verify it', dependsOn: ['tb'] },
  { taskId: 'td', title: 'Docs', prompt: 'brief: document it', dependsOn: [] },
]

function created(planId: string, title = 'Settings page'): StoredEvent {
  return event('plan.created', { planId, title, requirement: 'Add a settings page', tasks: TASKS })
}

function renderCanvas(children?: React.ReactNode): void {
  render(
    <SelectionProvider>
      <PlanProvider>
        <AgentTypesProvider>
          {children}
          <PlanCanvas />
        </AgentTypesProvider>
      </PlanProvider>
    </SelectionProvider>,
  )
}

afterEach(() => {
  delete window.agentinator
})

const view = (id: string, dependsOn: string[]): PlanTaskView => ({
  id,
  title: id,
  prompt: `do ${id}`,
  dependsOn,
  status: 'pending',
})

describe('layoutNodes', () => {
  it('columns tasks by dependency depth, rows in stored order', () => {
    const nodes = layoutNodes([view('a', []), view('b', ['a']), view('c', [])])

    expect(nodes[0].x).toBe(nodes[2].x) // both roots share column 0
    expect(nodes[2].y).toBeGreaterThan(nodes[0].y) // second row
    expect(nodes[1].x).toBeGreaterThan(nodes[0].x) // depth 1, next column
    expect(nodes[1].y).toBe(nodes[0].y) // first row of its column
  })
})

describe('chainOf', () => {
  it('collects the task plus everything upstream and downstream', () => {
    const tasks = [view('a', []), view('b', ['a']), view('c', ['b']), view('d', [])]

    expect(chainOf('b', tasks)).toEqual(new Set(['a', 'b', 'c']))
    expect(chainOf('d', tasks)).toEqual(new Set(['d']))
  })

  it('visits a diamond’s shared ancestor once and walks past ghost dependencies', () => {
    const diamond = [view('a', []), view('b', ['a']), view('c', ['a']), view('d', ['b', 'c'])]
    expect(chainOf('d', diamond)).toEqual(new Set(['a', 'b', 'c', 'd']))
    expect(chainOf('a', diamond)).toEqual(new Set(['a', 'b', 'c', 'd']))

    // A dependency id the plan doesn't carry ends the walk quietly.
    expect(chainOf('x', [view('x', ['ghost'])])).toEqual(new Set(['x', 'ghost']))
  })
})

describe('PlanCanvas', () => {
  it('shows the empty state when no plan exists', () => {
    renderCanvas() // no bridge — nothing to reduce
    expect(screen.getByText(/No plan yet/)).toBeInTheDocument()
  })

  it('renders the newest plan as nodes and removable edges', async () => {
    window.agentinator = stub([created('pl0', 'Older'), created('pl1')]).bridge

    renderCanvas()

    // Falls back to the newest plan without a selection.
    expect(await screen.findByText('Settings page')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trace Scaffold' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dispatch Scaffold' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dispatch Implement' })).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove dependency Scaffold → Implement' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove dependency Implement → Verify' }),
    ).toBeInTheDocument()
  })

  it('shows the selected plan rather than the newest', async () => {
    const s = stub([created('pl0', 'Older'), created('pl1', 'Newest')])
    window.agentinator = s.bridge
    function Pick(): React.JSX.Element {
      const { select } = useSelection()
      return (
        <button type="button" onClick={() => select({ kind: 'plan', id: 'pl0' })}>
          pick older
        </button>
      )
    }
    renderCanvas(<Pick />)

    expect(await screen.findByText('Newest')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'pick older' }))

    expect(screen.getByText('Older')).toBeInTheDocument()
    expect(screen.queryByText('Newest')).not.toBeInTheDocument()
  })

  it('dispatches a ready node and selects its agent', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    let selection: unknown
    function Probe(): null {
      selection = useSelection().selection
      return null
    }
    renderCanvas(<Probe />)

    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch Scaffold' }))
    expect(s.dispatch).toHaveBeenCalledWith('pl1', 'ta')
    await act(async () => {
      await Promise.resolve()
    })
    expect(selection).toEqual({ kind: 'session', id: 'sess_new' })
  })

  it('keeps the selection when a canvas dispatch is refused', async () => {
    const s = stub([created('pl1')])
    s.dispatch.mockReturnValueOnce(Promise.resolve(null))
    window.agentinator = s.bridge
    let selection: unknown
    function Probe(): null {
      selection = useSelection().selection
      return null
    }
    renderCanvas(<Probe />)

    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch Scaffold' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(selection).toBeNull()
  })

  it('traces a node’s chain, dimming nodes and edges outside it, and untraces', async () => {
    // Two disjoint chains, so the trace has an edge to dim as well as nodes.
    window.agentinator = stub([
      event('plan.created', {
        planId: 'plt',
        title: 'Trace me',
        requirement: 'r',
        tasks: [
          { taskId: 'a', title: 'A', prompt: '', dependsOn: [] },
          { taskId: 'b', title: 'B', prompt: '', dependsOn: ['a'] },
          { taskId: 'c', title: 'C', prompt: '', dependsOn: [] },
          { taskId: 'd', title: 'D', prompt: '', dependsOn: ['c'] },
        ],
      }),
    ]).bridge
    renderCanvas()

    fireEvent.click(await screen.findByRole('button', { name: 'Trace B' }))

    // A → B stays lit; the unrelated C → D chain dims, edge included.
    expect(screen.getByRole('button', { name: 'Trace C' }).closest('.plan-node')).toHaveClass(
      'is-dimmed',
    )
    expect(screen.getByRole('button', { name: 'Trace A' }).closest('.plan-node')).not.toHaveClass(
      'is-dimmed',
    )
    expect(document.querySelectorAll('.plan-edge.is-dimmed')).toHaveLength(1)
    expect(document.querySelectorAll('.plan-edge:not(.is-dimmed)')).toHaveLength(1)

    // Clicking the traced node again clears the trace.
    fireEvent.click(screen.getByRole('button', { name: 'Trace B' }))
    expect(screen.getByRole('button', { name: 'Trace C' }).closest('.plan-node')).not.toHaveClass(
      'is-dimmed',
    )
    expect(document.querySelectorAll('.plan-edge.is-dimmed')).toHaveLength(0)
  })

  it('arms a link source and draws the edge onto the next clicked node', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    renderCanvas()

    fireEvent.click(await screen.findByRole('button', { name: 'Link from Scaffold' }))
    expect(screen.getByRole('status')).toHaveTextContent('Linking from Scaffold')

    // Node bodies now offer the link target action instead of tracing.
    fireEvent.click(screen.getByRole('button', { name: 'Make Docs depend on Scaffold' }))
    expect(s.addEdge).toHaveBeenCalledWith('pl1', 'td', 'ta')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('cancels a link on the armed handle or on the source node itself', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    renderCanvas()

    // Arm, then click the handle again — disarmed, nothing drawn.
    fireEvent.click(await screen.findByRole('button', { name: 'Link from Scaffold' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel link from Scaffold' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    // Arm, then click the source node's own body — also just disarms.
    fireEvent.click(screen.getByRole('button', { name: 'Link from Scaffold' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make Scaffold depend on Scaffold' }))
    expect(s.addEdge).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('re-arms onto another source while a link is pending', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    renderCanvas()

    fireEvent.click(await screen.findByRole('button', { name: 'Link from Scaffold' }))
    fireEvent.click(screen.getByRole('button', { name: 'Link from Docs' }))
    expect(screen.getByRole('status')).toHaveTextContent('Linking from Docs')
  })

  it('removes an edge via its ✕ and reflects edge events live', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    renderCanvas()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove dependency Scaffold → Implement' }),
    )
    expect(s.removeEdge).toHaveBeenCalledWith('pl1', 'tb', 'ta')

    // The log answers: the edge folds out and Implement joins the frontier.
    act(() => {
      s.emit(event('plan.edge.removed', { planId: 'pl1', taskId: 'tb', dependsOnTaskId: 'ta' }))
    })
    expect(
      screen.queryByRole('button', { name: 'Remove dependency Scaffold → Implement' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dispatch Implement' })).toBeInTheDocument()

    // And a drawn edge appears: Docs now waits on Verify.
    act(() => {
      s.emit(event('plan.edge.added', { planId: 'pl1', taskId: 'td', dependsOnTaskId: 'tc' }))
    })
    expect(
      screen.getByRole('button', { name: 'Remove dependency Verify → Docs' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dispatch Docs' })).not.toBeInTheDocument()
  })

  it('skips drawing an edge whose dependency the plan does not carry', async () => {
    window.agentinator = stub([
      event('plan.created', {
        planId: 'plg',
        title: 'Ghosted',
        requirement: 'r',
        tasks: [{ taskId: 'tx', title: 'X', prompt: 'x', dependsOn: ['ghost'] }],
      }),
    ]).bridge

    renderCanvas()

    expect(await screen.findByRole('button', { name: 'Trace X' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove dependency/ })).not.toBeInTheDocument()

    // Its detail treats the ghost dependency as never-met: blocked, no name.
    fireEvent.click(screen.getByRole('button', { name: 'Trace X' }))
    expect(screen.getByRole('region', { name: 'Task details: X' })).toHaveTextContent('blocked')
  })

  it('scopes edge events to their plan and ignores a duplicate edge', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderCanvas()

    act(() => {
      s.emit(created('pl1', 'First'))
      s.emit(created('pl2', 'Second'))
      // A duplicate of an edge Implement already has — a no-op.
      s.emit(event('plan.edge.added', { planId: 'pl2', taskId: 'tb', dependsOnTaskId: 'ta' }))
      // Aimed at pl1 only — pl2 (the shown, newest plan) must keep its edge.
      s.emit(event('plan.edge.removed', { planId: 'pl1', taskId: 'tb', dependsOnTaskId: 'ta' }))
      s.emit(event('plan.edge.added', { planId: 'pl1', taskId: 'td', dependsOnTaskId: 'tc' }))
      // Same for a retype and a reprompt: pl2's Implement stays untouched.
      s.emit(event('plan.task.retyped', { planId: 'pl1', taskId: 'tb', agentTypeId: 'at_rev' }))
      s.emit(event('plan.task.reprompted', { planId: 'pl1', taskId: 'tb', prompt: 'pl1 only' }))
    })

    // The canvas shows pl2 (newest): its Scaffold→Implement edge survived the
    // pl1-scoped removal, no duplicate appeared, and pl1's new edge isn't here.
    expect(
      screen.getAllByRole('button', { name: 'Remove dependency Scaffold → Implement' }),
    ).toHaveLength(1)
    expect(
      screen.queryByRole('button', { name: 'Remove dependency Verify → Docs' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Trace Implement' }))
    expect(screen.getByRole('combobox', { name: 'Agent type for Implement' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Brief for Implement' })).toHaveValue(
      'brief: implement it',
    )
  })

  it('opens a task’s detail card on click: meta and an editable brief', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    renderCanvas()

    fireEvent.click(await screen.findByRole('button', { name: 'Trace Implement' }))

    // The card shows the exact brief the agent will run with, plus its meta.
    const detail = screen.getByRole('region', { name: 'Task details: Implement' })
    expect(detail).toHaveTextContent('blocked · after Scaffold')
    const brief = screen.getByRole('textbox', { name: 'Brief for Implement' })
    expect(brief).toHaveValue('brief: implement it')

    // Unchanged (or blank) drafts can't save; a submit sneaking past the
    // disabled button is still a no-op.
    const save = screen.getByRole('button', { name: 'Save brief' })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form') as HTMLFormElement)
    fireEvent.change(brief, { target: { value: '   ' } })
    expect(save).toBeDisabled()
    fireEvent.submit(save.closest('form') as HTMLFormElement)
    expect(s.reprompt).not.toHaveBeenCalled()

    // An edit routes through the bridge; the log's answer re-syncs the task,
    // leaving the draft saved (Save disables again).
    fireEvent.change(brief, { target: { value: 'brief: implement it with zustand' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(s.reprompt).toHaveBeenCalledWith('pl1', 'tb', 'brief: implement it with zustand')
    act(() => {
      s.emit(
        event('plan.task.reprompted', {
          planId: 'pl1',
          taskId: 'tb',
          prompt: 'brief: implement it with zustand',
        }),
      )
    })
    expect(screen.getByRole('button', { name: 'Save brief' })).toBeDisabled()

    // Clicking the node again closes the card with the trace; a root task
    // with no unmet dependencies reads as ready.
    fireEvent.click(screen.getByRole('button', { name: 'Trace Implement' }))
    expect(
      screen.queryByRole('region', { name: 'Task details: Implement' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Trace Docs' }))
    expect(screen.getByRole('region', { name: 'Task details: Docs' })).toHaveTextContent('ready')
    expect(screen.getByRole('combobox', { name: 'Agent type for Docs' })).toHaveValue('')
  })

  it('freezes a dispatched task’s brief read-only (steer the agent instead)', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    renderCanvas()
    await screen.findByText('Settings page')

    act(() => {
      s.emit(event('plan.task.dispatched', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Trace Scaffold' }))

    const detail = screen.getByRole('region', { name: 'Task details: Scaffold' })
    expect(detail).toHaveTextContent('brief: scaffold it')
    expect(screen.queryByRole('textbox', { name: 'Brief for Scaffold' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save brief' })).not.toBeInTheDocument()
  })

  it('assigns roles on the detail card — the one picker — with nodes wearing badges', async () => {
    const s = stub([
      event('plan.created', {
        planId: 'pl1',
        title: 'Typed',
        requirement: 'r',
        tasks: [
          { taskId: 'ta', title: 'Scaffold', prompt: 'a', dependsOn: [] },
          { taskId: 'tc', title: 'Verify', prompt: 'c', dependsOn: ['ta'], agentTypeId: 'at_rev' },
        ],
      }),
    ])
    window.agentinator = s.bridge
    renderCanvas()
    await screen.findByText('Typed')

    // Nodes carry no picker of their own — the typed one wears a badge.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByTitle('Role: Reviewer')).toBeInTheDocument()

    // The detail card's picker pre-selects the decomposer's suggestion…
    fireEvent.click(screen.getByRole('button', { name: 'Trace Verify' }))
    const verifyPick = screen.getByRole('combobox', { name: 'Agent type for Verify' })
    expect(verifyPick).toHaveValue('at_rev')
    // …and returning it to Default sends null.
    fireEvent.change(verifyPick, { target: { value: '' } })
    expect(s.retype).toHaveBeenCalledWith('pl1', 'tc', null)

    // Assign the untyped task a role; the log's answer badges its node.
    fireEvent.click(screen.getByRole('button', { name: 'Trace Verify' })) // close
    fireEvent.click(screen.getByRole('button', { name: 'Trace Scaffold' }))
    const scaffoldPick = screen.getByRole('combobox', { name: 'Agent type for Scaffold' })
    expect(scaffoldPick).toHaveValue('')
    fireEvent.change(scaffoldPick, { target: { value: 'at_doc' } })
    expect(s.retype).toHaveBeenCalledWith('pl1', 'ta', 'at_doc')
    act(() => {
      s.emit(event('plan.task.retyped', { planId: 'pl1', taskId: 'ta', agentTypeId: 'at_doc' }))
      s.emit(event('plan.task.retyped', { planId: 'pl1', taskId: 'tc', agentTypeId: null }))
    })
    expect(scaffoldPick).toHaveValue('at_doc')
    expect(screen.getByTitle('Role: Doc writer')).toBeInTheDocument()
    expect(screen.queryByTitle('Role: Reviewer')).not.toBeInTheDocument()
  })

  it('freezes a dispatched task’s role: no picker, a badge and read-only meta', async () => {
    const s = stub([
      event('plan.created', {
        planId: 'pl1',
        title: 'Typed',
        requirement: 'r',
        tasks: [
          { taskId: 'ta', title: 'Scaffold', prompt: 'a', dependsOn: [], agentTypeId: 'at_rev' },
          { taskId: 'td', title: 'Docs', prompt: 'd', dependsOn: [], agentTypeId: 'at_gone' },
        ],
      }),
    ])
    window.agentinator = s.bridge
    renderCanvas()
    await screen.findByText('Typed')

    act(() => {
      s.emit(event('plan.task.dispatched', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
      s.emit(event('plan.task.dispatched', { planId: 'pl1', taskId: 'td', sessionId: 's1' }))
    })

    // Once launched, the role is a fact — the detail card shows it as text,
    // never a picker; a type deleted since assignment falls back to its id.
    fireEvent.click(screen.getByRole('button', { name: 'Trace Scaffold' }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Task details: Scaffold' })).toHaveTextContent(
      'running · Reviewer',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Trace Docs' }))
    expect(screen.getByRole('region', { name: 'Task details: Docs' })).toHaveTextContent(
      'running · at_gone',
    )
    expect(screen.getByTitle('Role: at_gone')).toBeInTheDocument()
  })

  it('closes the card (and reports it) when the traced task leaves the shown plan', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    const onInspect = vi.fn()
    render(
      <SelectionProvider>
        <PlanProvider>
          <AgentTypesProvider>
            <PlanCanvas onInspect={onInspect} />
          </AgentTypesProvider>
        </PlanProvider>
      </SelectionProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Trace Scaffold' }))
    expect(onInspect).toHaveBeenLastCalledWith('ta')

    // A newer plan (different task ids) takes the canvas — the stale trace
    // opens no card, and the parent hears that.
    act(() => {
      s.emit(
        event('plan.created', {
          planId: 'plx',
          title: 'Other',
          requirement: 'r',
          tasks: [{ taskId: 'zz', title: 'Z', prompt: 'z', dependsOn: [] }],
        }),
      )
    })
    expect(screen.queryByRole('region', { name: /Task details/ })).not.toBeInTheDocument()
    expect(onInspect).toHaveBeenLastCalledWith(null)

    // With every plan gone the empty state returns, stale trace and all.
    act(() => {
      s.emit(event('plan.removed', { planId: 'pl1' }))
      s.emit(event('plan.removed', { planId: 'plx' }))
    })
    expect(screen.getByText(/No plan yet/)).toBeInTheDocument()
  })

  it('shows node status from the log (running, done, failed)', async () => {
    const s = stub([created('pl1')])
    window.agentinator = s.bridge
    renderCanvas()
    await screen.findByText('Settings page')

    act(() => {
      s.emit(event('plan.task.dispatched', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
      s.emit(event('plan.task.dispatched', { planId: 'pl1', taskId: 'td', sessionId: 's1' }))
      s.emit(event('plan.task.completed', { planId: 'pl1', taskId: 'ta', sessionId: 's0' }))
      s.emit(event('plan.task.failed', { planId: 'pl1', taskId: 'td', sessionId: 's1' }))
    })

    expect(screen.getByTitle('Scaffold — done')).toBeInTheDocument()
    expect(screen.getByTitle('Docs — failed')).toBeInTheDocument()
    // A failed root returns to the frontier for a retry.
    expect(screen.getByRole('button', { name: 'Dispatch Docs' })).toBeInTheDocument()
  })
})
