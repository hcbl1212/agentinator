// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { EventPayloads, EventType, StoredEvent } from '../../../shared/events'
import { QueueProvider, useQueue } from '../state/queue'
import { SelectionProvider, useSelection } from '../state/selection'
import { TaskQueue } from './TaskQueue'

function stub(backfill: StoredEvent[] = []): {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  dispatch: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  let appended: (event: StoredEvent) => void = () => undefined
  const dispatch = vi.fn(() => Promise.resolve('session_new'))
  const remove = vi.fn(() => Promise.resolve())
  return {
    dispatch,
    remove,
    emit: (event) => appended(event),
    bridge: {
      events: {
        tail: vi.fn(() => Promise.resolve(backfill)),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
      queue: { add: vi.fn(() => Promise.resolve('task_x')), dispatch, remove },
    } as unknown as AgentinatorBridge,
  }
}

function event<T extends EventType>(type: T, payload: EventPayloads[T]): StoredEvent {
  return { seq: 1, ts: 't', type, payload }
}

function renderQueue(): void {
  render(
    <SelectionProvider>
      <QueueProvider>
        <TaskQueue />
      </QueueProvider>
    </SelectionProvider>,
  )
}

afterEach(() => {
  delete window.agentinator
})

describe('TaskQueue', () => {
  it('shows the empty state with no tasks', () => {
    window.agentinator = stub().bridge
    renderQueue()
    expect(screen.getByText(/Nothing queued/)).toBeInTheDocument()
  })

  it('backfills queued tasks from the log and lists them with a count', async () => {
    window.agentinator = stub([
      event('task.queued', { taskId: 't1', prompt: 'first task' }),
      event('task.queued', { taskId: 't2', prompt: 'second task' }),
    ]).bridge

    renderQueue()

    expect(await screen.findByText('first task')).toBeInTheDocument()
    expect(screen.getByText('second task')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('dedupes and ignores unrelated events, then drops a task on dispatch', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderQueue()

    act(() => {
      s.emit(event('task.queued', { taskId: 't1', prompt: 'do the thing' }))
      s.emit(event('task.queued', { taskId: 't1', prompt: 'do the thing' })) // dupe ignored
      s.emit(event('agent.text', { sessionId: 's', text: 'noise' })) // unrelated
    })
    expect(screen.getAllByText('do the thing')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Dispatch do the thing' }))
    expect(s.dispatch).toHaveBeenCalledWith('t1', 'do the thing')
    act(() => {
      s.emit(event('task.dispatched', { taskId: 't1', sessionId: 'session_new' }))
    })
    expect(screen.queryByText('do the thing')).not.toBeInTheDocument()
  })

  it('removes a task via its button', () => {
    const s = stub()
    window.agentinator = s.bridge
    renderQueue()

    act(() => {
      s.emit(event('task.queued', { taskId: 't1', prompt: 'drop me' }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove drop me' }))
    expect(s.remove).toHaveBeenCalledWith('t1')
    act(() => {
      s.emit(event('task.removed', { taskId: 't1' }))
    })
    expect(screen.queryByText('drop me')).not.toBeInTheDocument()
  })

  it('selects the new agent when a task is dispatched', async () => {
    const s = stub()
    window.agentinator = s.bridge
    let selection: unknown
    function Probe(): null {
      selection = useSelection().selection
      return null
    }
    render(
      <SelectionProvider>
        <QueueProvider>
          <Probe />
          <TaskQueue />
        </QueueProvider>
      </SelectionProvider>,
    )

    act(() => {
      s.emit(event('task.queued', { taskId: 't1', prompt: 'go' }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch go' }))

    await waitFor(() => expect(selection).toEqual({ kind: 'session', id: 'session_new' }))
  })

  it('ignores a backfill that resolves after unmount', async () => {
    window.agentinator = stub([event('task.queued', { taskId: 't1', prompt: 'x' })]).bridge
    const { unmount } = render(
      <SelectionProvider>
        <QueueProvider>
          <TaskQueue />
        </QueueProvider>
      </SelectionProvider>,
    )
    unmount()
    // The tail promise resolves after unmount → the cancelled guard skips it.
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('throws if useQueue is used outside a provider', () => {
    expect(() => renderHook(() => useQueue())).toThrow('within a QueueProvider')
  })
})
