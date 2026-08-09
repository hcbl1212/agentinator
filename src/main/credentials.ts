import type { SettingsStore } from './settingsStore'

/**
 * Encrypts/decrypts a credential at rest. In the app this wraps Electron's
 * `safeStorage` (OS keychain); tests inject a fake. `available` is false when
 * the platform has no secure store — then we simply don't persist.
 */
export interface Encryptor {
  available: boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

/**
 * Holds API keys for switching an agent off its subscription onto a metered
 * credential — vendor-neutral, keyed by provider id. Plaintext lives in memory
 * only; persistence (opt-in) stores just the ciphertext via the injected
 * encryptor, so a key never touches disk unencrypted or the event log.
 */
export class CredentialVault {
  #memory = new Map<string, string>()
  #store: SettingsStore
  #enc: Encryptor

  constructor(store: SettingsStore, encryptor: Encryptor) {
    this.#store = store
    this.#enc = encryptor
    // Rehydrate persisted keys into memory (best-effort — a rotated OS key or a
    // missing secure store just means the user re-enters them).
    if (encryptor.available) {
      for (const { id, ciphertext } of store.secrets()) {
        try {
          this.#memory.set(id, encryptor.decrypt(ciphertext))
        } catch {
          // Undecryptable — drop it; the user can re-enter.
        }
      }
    }
  }

  /** Store a key for a provider; `persist` also saves it (encrypted) to disk. */
  set(providerId: string, key: string, persist: boolean): void {
    this.#memory.set(providerId, key)
    if (persist && this.#enc.available) {
      this.#store.saveSecret(providerId, this.#enc.encrypt(key))
    }
  }

  get(providerId: string): string | undefined {
    return this.#memory.get(providerId)
  }

  has(providerId: string): boolean {
    return this.#memory.has(providerId)
  }

  clear(providerId: string): void {
    this.#memory.delete(providerId)
    this.#store.deleteSecret(providerId)
  }
}
