// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import type { StoredEvent } from '../../../shared/events'
import { ConversationLog } from './ConversationLog'

interface Stub {
  bridge: AgentinatorBridge
  emit: (event: StoredEvent) => void
  resolveTail: (events: StoredEvent[]) => void
}

function stubBridge(tail?: StoredEvent[]): Stub {
  let appended: ((event: StoredEvent) => void) | undefined
  let resolveTail: (events: StoredEvent[]) => void = () => undefined
  const tailPromise =
    tail === undefined
      ? new Promise<StoredEvent[]>((resolve) => {
          resolveTail = resolve
        })
      : Promise.resolve(tail)
  return {
    emit: (event) => appended?.(event),
    resolveTail,
    bridge: {
      events: {
        count: vi.fn(() => Promise.resolve(0)),
        totalCost: vi.fn(() => Promise.resolve(0)),
        diffs: vi.fn(() => Promise.resolve([])),
        list: vi.fn(() => Promise.resolve([])),
        tail: vi.fn(() => tailPromise),
        search: vi.fn(() => Promise.resolve([])),
        onAppended: vi.fn((listener: (event: StoredEvent) => void) => {
          appended = listener
          return () => undefined
        }),
      },
    } as unknown as AgentinatorBridge,
  }
}

function ev(type: StoredEvent['type'], payload: object, seq: number): StoredEvent {
  return { seq, ts: 't', type, payload } as StoredEvent
}

afterEach(() => {
  delete window.agentinator
})

describe('ConversationLog', () => {
  it('renders the empty state without a bridge', () => {
    render(<ConversationLog />)

    expect(screen.getByText(/conversation with the agent appears here/)).toBeInTheDocument()
  })

  it('renders conversation lines and filters out non-conversation events', async () => {
    const stub = stubBridge([
      ev(
        'session.started',
        { sessionId: 's', agentId: 'a', workspaceId: 'w', title: 'Add greet' },
        1,
      ),
      ev('agent.text', { sessionId: 's', text: 'On it.' }, 2),
      ev(
        'cost.usage',
        { sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, usd: 0.01 },
        3,
      ),
    ])
    window.agentinator = stub.bridge

    render(<ConversationLog />)

    await waitFor(() => {
      expect(screen.getByText('On it.')).toBeInTheDocument()
    })
    expect(screen.getByText(/session started · Add greet/)).toBeInTheDocument()
    // cost.usage is excluded from the conversation console.
    expect(screen.queryByText(/\$0\.01/)).not.toBeInTheDocument()
  })

  it('appends live conversation events', async () => {
    const stub = stubBridge([])
    window.agentinator = stub.bridge

    render(<ConversationLog />)
    act(() => {
      stub.emit(ev('user.message', { sessionId: 's', text: 'keep going' }, 5))
    })

    await waitFor(() => {
      expect(screen.getByText('keep going')).toBeInTheDocument()
    })
  })

  it('ignores a tail page that resolves after unmount', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge

    const { unmount } = render(<ConversationLog />)
    unmount()
    stub.resolveTail([ev('agent.text', { sessionId: 's', text: 'late' }, 9)])
    await Promise.resolve()

    expect(screen.queryByText('late')).not.toBeInTheDocument()
  })

  it('reveals ↓ Latest when scrolled up and re-pins on click', async () => {
    // Give the trailing anchor a real scrollIntoView so the pinned autoscroll
    // and the re-pin both exercise their happy path.
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView

    const stub = stubBridge([ev('agent.text', { sessionId: 's', text: 'hello' }, 1)])
    window.agentinator = stub.bridge

    render(<ConversationLog />)
    await screen.findByText('hello')

    const log = document.querySelector('.convo-log') as HTMLElement
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'scrollTop', { value: 0, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true })
    fireEvent.scroll(log)

    const latest = screen.getByRole('button', { name: /Latest/ })
    fireEvent.click(latest)

    expect(scrollIntoView).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Latest/ })).not.toBeInTheDocument()
  })
})
