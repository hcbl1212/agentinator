import { useEffect, useState } from 'react'

import type { AgentDescriptor } from '../../../shared/bridge'

/** One provider's key field. Save persists to the OS keychain; the field can
 * store and clear a key but never read it back. */
function CredentialRow({
  label,
  providerId,
  saved,
  onSaved,
}: {
  label: string
  providerId: string
  saved: boolean
  onSaved: (saved: boolean) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')

  const save = (): void => {
    const bridge = window.agentinator
    const key = draft.trim()
    if (bridge === undefined || key === '') {
      return
    }
    void bridge.credentials.set(providerId, key, true).then(() => {
      onSaved(true)
      setDraft('')
    })
  }
  const clear = (): void => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    void bridge.credentials.clear(providerId).then(() => onSaved(false))
  }

  return (
    <label className="credential-row">
      <span className="credential-label">
        {label} {saved && <span className="credential-saved">saved</span>}
      </span>
      <input
        type="password"
        className="credential-input"
        aria-label={`${label} API key`}
        placeholder={saved ? '•••••••• (replace)' : 'sk-…'}
        value={draft}
        onChange={(changed) => setDraft(changed.target.value)}
        onKeyDown={(pressed) => {
          if (pressed.key === 'Enter') {
            save()
          }
        }}
      />
      <span className="credential-actions">
        <button type="button" className="credential-save" onClick={save}>
          Save
        </button>
        {saved && (
          <button type="button" className="credential-clear" onClick={clear}>
            Clear
          </button>
        )}
      </span>
    </label>
  )
}

/**
 * Set the metered API key used when switching an agent off its subscription.
 * Vendor-neutral: it targets whichever provider new tasks run on. The key is
 * saved to the OS keychain and never leaves the main process — this panel can
 * store and clear it, but can never read it back.
 */
export function CredentialsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [provider, setProvider] = useState<AgentDescriptor | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const bridge = window.agentinator
    if (bridge === undefined) {
      return
    }
    let cancelled = false
    void (async () => {
      const descriptor = await bridge.agent.current()
      const has = await bridge.credentials.has(descriptor.providerId)
      if (!cancelled) {
        setProvider(descriptor)
        setSaved(has)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="credentials-panel" role="dialog" aria-label="API keys">
      <div className="budget-panel-head">
        <span className="pane-label">API keys</span>
        <button
          type="button"
          className="budget-panel-close"
          aria-label="Close API keys"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {provider !== null && (
        <CredentialRow
          label={provider.label}
          providerId={provider.providerId}
          saved={saved}
          onSaved={setSaved}
        />
      )}
      <p className="budget-panel-note">
        Used when you switch an agent off its subscription. Stored in your OS keychain — never in
        the project.
      </p>
    </div>
  )
}
