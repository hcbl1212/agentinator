// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentinatorBridge } from '../../../shared/bridge'
import { CredentialsPanel } from './CredentialsPanel'

function stubBridge(options: { hasKey?: boolean; mode?: boolean } = {}): {
  bridge: AgentinatorBridge
  set: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
  setApiKeyMode: ReturnType<typeof vi.fn>
} {
  const set = vi.fn(() => Promise.resolve())
  const clear = vi.fn(() => Promise.resolve())
  const setApiKeyMode = vi.fn(() => Promise.resolve())
  return {
    set,
    clear,
    setApiKeyMode,
    bridge: {
      agent: { current: vi.fn(() => Promise.resolve({ providerId: 'claude', label: 'Claude' })) },
      credentials: { has: vi.fn(() => Promise.resolve(options.hasKey ?? false)), set, clear },
      settings: {
        getApiKeyMode: vi.fn(() => Promise.resolve(options.mode ?? false)),
        setApiKeyMode,
      },
    } as unknown as AgentinatorBridge,
  }
}

afterEach(() => {
  delete window.agentinator
})

describe('CredentialsPanel', () => {
  it('renders the dialog with no key field when there is no bridge', () => {
    render(<CredentialsPanel onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'API keys' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('shows an empty field for the current provider and saves a key to the keychain', async () => {
    const stub = stubBridge({ hasKey: false })
    window.agentinator = stub.bridge

    render(<CredentialsPanel onClose={vi.fn()} />)
    const field = await screen.findByLabelText('Claude API key')
    expect(field).toHaveAttribute('placeholder', 'sk-…')
    expect(screen.queryByText('saved')).not.toBeInTheDocument()

    await userEvent.type(field, 'sk-live-123')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(stub.set).toHaveBeenCalledWith('claude', 'sk-live-123', true)
    expect(await screen.findByText('saved')).toBeInTheDocument()
    expect(field).toHaveValue('') // draft cleared
  })

  it('shows saved state and clears an existing key (and saves via Enter)', async () => {
    const stub = stubBridge({ hasKey: true })
    window.agentinator = stub.bridge

    render(<CredentialsPanel onClose={vi.fn()} />)
    await screen.findByText('saved')
    const field = screen.getByLabelText('Claude API key')
    expect(field).toHaveAttribute('placeholder', '•••••••• (replace)')

    await userEvent.type(field, 'sk-new{Enter}')
    expect(stub.set).toHaveBeenCalledWith('claude', 'sk-new', true)

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(stub.clear).toHaveBeenCalledWith('claude')
    await waitFor(() => {
      expect(screen.queryByText('saved')).not.toBeInTheDocument()
    })
  })

  it('reflects and toggles the run-on-API-key setting', async () => {
    const stub = stubBridge({ mode: true })
    window.agentinator = stub.bridge

    render(<CredentialsPanel onClose={vi.fn()} />)
    const toggle = await screen.findByRole('checkbox', { name: /Run all agents on the API key/ })
    expect(toggle).toBeChecked()

    await userEvent.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(stub.setApiKeyMode).toHaveBeenCalledWith(false)
  })

  it('ignores an empty save and a vanished bridge', async () => {
    const stub = stubBridge({ hasKey: true })
    window.agentinator = stub.bridge

    render(<CredentialsPanel onClose={vi.fn()} />)
    await screen.findByText('saved')

    // Empty draft → Save is a no-op.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(stub.set).not.toHaveBeenCalled()

    // Bridge gone → Save and Clear can't crash or act.
    delete window.agentinator
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(stub.clear).not.toHaveBeenCalled()
  })

  it('ignores a load that resolves after unmount, and closes', async () => {
    const stub = stubBridge()
    window.agentinator = stub.bridge
    const onClose = vi.fn()

    const { unmount } = render(<CredentialsPanel onClose={onClose} />)
    unmount()
    // Let the pending agent.current()/has() microtasks flush after unmount.
    await Promise.resolve()
    await Promise.resolve()

    // Re-render just to exercise the close button.
    render(<CredentialsPanel onClose={onClose} />)
    await userEvent.click(screen.getAllByRole('button', { name: 'Close API keys' })[0])
    expect(onClose).toHaveBeenCalled()
  })
})
