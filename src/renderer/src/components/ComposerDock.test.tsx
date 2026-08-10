// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge, PendingApproval } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { SelectionProvider } from '../state/selection'
import { SessionsProvider } from '../state/sessions'
import { ComposerDock } from './ComposerDock'

interface BridgeStub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  startTask: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
}

function stubBridge(pending: PendingApproval[] = []): BridgeStub {
  const listeners: ((event: StoredEvent) => void)[] = []
  const startTask = vi.fn(() => Promise.resolve('session_task'))
  const send = vi.fn(() => Promise.resolve())
  const resolve = vi.fn(() => Promise.resolve())
  return {
    startTask,
    send,
    resolve,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => Promise.resolve([])),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          listeners.push(listener)
          return () => undefined
        }),
      },
      settings: {
        getBudgets: vi.fn(() =>
          Promise.resolve({ session: 5, hour: null, day: null, week: null, month: null }),
        ),
        setBudget: vi.fn(() => Promise.resolve()),
        getApiKeyMode: vi.fn(() => Promise.resolve(false)),
        setApiKeyMode: vi.fn(() => Promise.resolve()),
        getPreviewTarget: vi.fn(() => Promise.resolve(null)),
        setPreviewTarget: vi.fn(() => Promise.resolve()),
      },
      agent: {
        current: vi.fn(() => Promise.resolve({ providerId: 'claude', label: 'Claude' })),
        startDemo: vi.fn(() => Promise.resolve('session_1')),
        startTask: startTask,
        send: send,
        cancel: vi.fn(() => Promise.resolve()),
        dismiss: vi.fn(() => Promise.resolve()),
        switchToApiKey: vi.fn(() => Promise.resolve()),
        switchToSubscription: vi.fn(() => Promise.resolve()),
      },
      preview: {
        capture: vi.fn(() => Promise.resolve('shot_1')),
        image: vi.fn(() => Promise.resolve(null)),
      },
      approvals: {
        pending: vi.fn(() => Promise.resolve(pending)),
        resolve: resolve,
        undo: vi.fn(() => Promise.resolve()),
      },
      credentials: {
        set: vi.fn(() => Promise.resolve()),
        has: vi.fn(() => Promise.resolve(false)),
        clear: vi.fn(() => Promise.resolve()),
      },
    },
  }
}

function started(sessionId: string, title: string): StoredEvent {
  return {
    seq: 1,
    ts: 't',
    type: 'session.started',
    payload: { sessionId, agentId: 'a', workspaceId: 'w', title },
  }
}

function event(type: StoredEvent['type'], payload: object): StoredEvent {
  return { seq: 1, ts: 't', type, payload } as StoredEvent
}

function requested(requestId: string): StoredEvent {
  return event('approval.requested', {
    sessionId: 's',
    requestId,
    tool: 'bash',
    input: { command: 'git push' },
  })
}

function imageFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
}

function paste(input: HTMLElement, items: unknown[], files: File[] = []): void {
  fireEvent.paste(input, { clipboardData: { items, files } })
}

function drop(node: HTMLElement, items: unknown[], files: File[] = []): void {
  fireEvent.drop(node, { dataTransfer: { items, files } })
}

function renderDock(): void {
  render(
    <SelectionProvider>
      <SessionsProvider>
        <ComposerDock />
      </SessionsProvider>
    </SelectionProvider>,
  )
}

/** Launch a task and make its session live + selected → reply mode. */
async function activate(stub: BridgeStub): Promise<void> {
  await userEvent.type(screen.getByRole('textbox', { name: 'Task for the agent' }), 'Do it{Enter}')
  act(() => {
    stub.emit(started('session_task', 'Do it'))
  })
  await screen.findByRole('textbox', { name: 'Reply to the agent' })
}

afterEach(() => {
  delete window.agentinator
})

describe('ComposerDock', () => {
  it('shows a placeholder and no composer without a bridge', () => {
    renderDock()

    expect(screen.getByText(/Open a workspace to talk to an agent/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Task for the agent' })).not.toBeInTheDocument()
  })

  it('focuses the prompt so you can start typing a new task immediately', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()

    expect(screen.getByRole('textbox', { name: 'Task for the agent' })).toHaveFocus()
  })

  it('launches a new agent from the console prompt and clears it', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    const input = screen.getByRole('textbox', { name: 'Task for the agent' })
    await userEvent.type(input, 'Add a hello util{Enter}')

    expect(stub.startTask).toHaveBeenCalledWith('Add a hello util', [])
    expect(input).toHaveValue('')
  })

  it('sends on Enter and treats Shift+Enter as a newline, not a send', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    const input = screen.getByRole('textbox', { name: 'Task for the agent' })

    await userEvent.type(input, 'first line')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(stub.startTask).not.toHaveBeenCalled()

    await userEvent.type(input, '{Enter}')
    expect(stub.startTask).toHaveBeenCalledWith('first line', [])
  })

  it('ignores an empty/whitespace submission', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    await userEvent.type(screen.getByRole('textbox', { name: 'Task for the agent' }), '   {Enter}')

    expect(stub.startTask).not.toHaveBeenCalled()
  })

  it('replies to the selected agent', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    await activate(stub)

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Reply to the agent' }),
      'also add tests{Enter}',
    )
    expect(stub.send).toHaveBeenCalledWith('session_task', 'also add tests', [])
  })

  it('"/clear" drops the selected agent and returns to launch mode without sending', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    await activate(stub)

    const reply = screen.getByRole('textbox', { name: 'Reply to the agent' })
    await userEvent.type(reply, '/clear{Enter}')

    expect(stub.send).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Task for the agent' })).toBeInTheDocument()
  })

  it('renders the selected agent’s question as a card and answers via a follow-up', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    await activate(stub)
    act(() => {
      stub.emit(
        event('agent.question', {
          sessionId: 'session_task',
          requestId: 'approval_q',
          questions: [{ question: 'Which approach?', options: ['Continue', 'Restart'] }],
        }),
      )
    })

    expect(screen.getByLabelText('Agent question')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(stub.send).toHaveBeenCalledWith('session_task', 'Continue', [])
    expect(screen.queryByLabelText('Agent question')).not.toBeInTheDocument()
  })

  it('does not show a question meant for a different agent', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    await activate(stub)
    act(() => {
      stub.emit(
        event('agent.question', {
          sessionId: 'other',
          requestId: 'approval_x',
          questions: [{ question: 'ignored?', options: [] }],
        }),
      )
    })

    expect(screen.queryByLabelText('Agent question')).not.toBeInTheDocument()
  })

  it('drops the question and returns to launch mode when the agent ends', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    await activate(stub)
    act(() => {
      stub.emit(
        event('agent.question', {
          sessionId: 'session_task',
          requestId: 'approval_q',
          questions: [{ question: 'Which approach?', options: ['Continue'] }],
        }),
      )
    })
    expect(screen.getByLabelText('Agent question')).toBeInTheDocument()

    act(() => {
      stub.emit(event('session.ended', { sessionId: 'session_task', outcome: 'completed' }))
    })

    expect(screen.queryByLabelText('Agent question')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Task for the agent' })).toBeInTheDocument()
  })

  it('shows already-pending approvals and resolves them via the bridge', async () => {
    const stub = stubBridge([
      { requestId: 'approval_1', sessionId: 's', tool: 'write', input: { path: 'a.ts' } },
    ])
    window.agentinator = stub.bridge

    renderDock()
    await waitFor(() => {
      expect(screen.getByText('write a.ts')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(stub.resolve).toHaveBeenCalledWith('approval_1', true)
  })

  it('adds live approval requests (deduped) and removes them when resolved', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    await waitFor(() => {
      expect(stub.bridge.approvals.pending).toHaveBeenCalled()
    })

    act(() => {
      stub.emit(requested('approval_9'))
      stub.emit(requested('approval_9'))
    })
    expect(screen.getAllByText('bash git push')).toHaveLength(1)

    act(() => {
      stub.emit(
        event('approval.resolved', {
          sessionId: 's',
          requestId: 'approval_9',
          approved: false,
          via: 'user',
        }),
      )
    })
    expect(screen.queryByText('bash git push')).not.toBeInTheDocument()
  })

  it('denying enters a grace window and Undo aborts it', async () => {
    const stub = stubBridge([
      { requestId: 'approval_2', sessionId: 's', tool: 'write', input: { path: 'b.ts' } },
    ])
    window.agentinator = stub.bridge

    renderDock()
    await waitFor(() => {
      expect(screen.getByText('write b.ts')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(stub.resolve).toHaveBeenCalledWith('approval_2', false)

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(stub.bridge.approvals.undo).toHaveBeenCalledWith('approval_2')
  })

  it('ignores a pending list that resolves after unmount', async () => {
    let resolvePending: (pending: PendingApproval[]) => void = () => undefined
    const stub = stubBridge()
    ;(stub.bridge.approvals.pending as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<PendingApproval[]>((resolve) => {
        resolvePending = resolve
      }),
    )
    window.agentinator = stub.bridge

    const { unmount } = render(
      <SelectionProvider>
        <SessionsProvider>
          <ComposerDock />
        </SessionsProvider>
      </SelectionProvider>,
    )
    unmount()
    resolvePending([
      { requestId: 'approval_late', sessionId: 's', tool: 'write', input: { path: 'b.ts' } },
    ])
    await Promise.resolve()

    expect(screen.queryByText('write b.ts')).not.toBeInTheDocument()
  })

  it('attaches a pasted screenshot and sends it (image-only is allowed)', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    const input = screen.getByRole('textbox', { name: 'Task for the agent' })
    paste(input, [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile() }])

    await screen.findByAltText('pasted screenshot')
    await userEvent.type(input, '{Enter}')

    expect(stub.startTask).toHaveBeenCalledWith('', [{ mediaType: 'image/png', data: 'AQID' }])
    expect(screen.queryByAltText('pasted screenshot')).not.toBeInTheDocument()
  })

  it('ignores a paste that carries no image', () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    const input = screen.getByRole('textbox', { name: 'Task for the agent' })
    paste(input, [{ kind: 'string', type: 'text/plain', getAsFile: () => null }])

    expect(screen.queryByAltText('pasted screenshot')).not.toBeInTheDocument()
  })

  it('keeps only real image files from a mixed paste, and removes a thumbnail on demand', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    const input = screen.getByRole('textbox', { name: 'Task for the agent' })
    paste(input, [
      { kind: 'file', type: 'image/png', getAsFile: () => imageFile() },
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'text/plain', getAsFile: () => imageFile() },
      { kind: 'file', type: 'image/png', getAsFile: () => null },
    ])

    const thumbs = await screen.findAllByAltText('pasted screenshot')
    expect(thumbs).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: 'Remove image' }))
    expect(screen.queryByAltText('pasted screenshot')).not.toBeInTheDocument()
  })

  it('falls back to clipboard files when there are no image items', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    const input = screen.getByRole('textbox', { name: 'Task for the agent' })
    paste(input, [], [imageFile(), new File(['x'], 'note.txt', { type: 'text/plain' })])

    const thumbs = await screen.findAllByAltText('pasted screenshot')
    expect(thumbs).toHaveLength(1)
  })

  it('accepts an image dropped onto the composer, and ignores a non-image drop', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    renderDock()
    const dock = screen.getByLabelText('Composer')
    fireEvent.dragOver(dock)

    drop(dock, [], [new File(['x'], 'note.txt', { type: 'text/plain' })])
    expect(screen.queryByAltText('pasted screenshot')).not.toBeInTheDocument()

    drop(dock, [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile() }])
    expect(await screen.findByAltText('pasted screenshot')).toBeInTheDocument()
  })
})
