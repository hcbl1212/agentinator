import { describe, expect, it } from 'vitest'

import { CredentialVault } from './credentials'
import type { Encryptor } from './credentials'
import { SettingsStore } from './settingsStore'

/** A reversible fake keychain: ciphertext is `enc(<plain>)`. */
function fakeEncryptor(available = true): Encryptor {
  return {
    available,
    encrypt: (plain) => `enc(${plain})`,
    decrypt: (cipher) => {
      if (!cipher.startsWith('enc(')) {
        throw new Error('undecryptable')
      }
      return cipher.slice('enc('.length, -1)
    },
  }
}

describe('CredentialVault', () => {
  it('holds a key in memory without persisting when persist is false', () => {
    const store = new SettingsStore()
    const vault = new CredentialVault(store, fakeEncryptor())

    vault.set('claude', 'sk-123', false)

    expect(vault.get('claude')).toBe('sk-123')
    expect(vault.has('claude')).toBe(true)
    expect(store.readSecret('claude')).toBeUndefined()
    store.close()
  })

  it('persists ciphertext (never plaintext) and rehydrates it into a new vault', () => {
    const store = new SettingsStore()
    new CredentialVault(store, fakeEncryptor()).set('claude', 'sk-live', true)

    // On disk it's ciphertext, not the key.
    expect(store.readSecret('claude')).toBe('enc(sk-live)')

    // A fresh vault over the same store decrypts it back into memory.
    const reopened = new CredentialVault(store, fakeEncryptor())
    expect(reopened.get('claude')).toBe('sk-live')
    store.close()
  })

  it('does not persist when the encryptor is unavailable', () => {
    const store = new SettingsStore()
    const vault = new CredentialVault(store, fakeEncryptor(false))

    vault.set('claude', 'sk-123', true)

    expect(vault.get('claude')).toBe('sk-123') // still usable this session
    expect(store.readSecret('claude')).toBeUndefined() // but nothing written
    store.close()
  })

  it('drops an undecryptable stored secret instead of crashing', () => {
    const store = new SettingsStore()
    store.saveSecret('claude', 'not-our-ciphertext')

    const vault = new CredentialVault(store, fakeEncryptor())

    expect(vault.has('claude')).toBe(false)
    store.close()
  })

  it('clears a key from memory and disk', () => {
    const store = new SettingsStore()
    const vault = new CredentialVault(store, fakeEncryptor())
    vault.set('claude', 'sk-123', true)

    vault.clear('claude')

    expect(vault.has('claude')).toBe(false)
    expect(store.readSecret('claude')).toBeUndefined()
    store.close()
  })
})
