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
  #rehydrated = false

  constructor(store: SettingsStore, encryptor: Encryptor) {
    this.#store = store
    this.#enc = encryptor
  }

  /** Load persisted keys into memory on first use — never at boot. Touching the
   * OS keychain triggers a password prompt on an unsigned build, so an install
   * that has never saved a key never prompts. Best-effort: a rotated OS key or
   * missing secure store just means the user re-enters them. */
  #rehydrate(): void {
    if (this.#rehydrated) {
      return
    }
    this.#rehydrated = true
    const stored = this.#store.secrets()
    if (stored.length === 0 || !this.#enc.available) {
      return
    }
    for (const { id, ciphertext } of stored) {
      try {
        this.#memory.set(id, this.#enc.decrypt(ciphertext))
      } catch {
        // Undecryptable — drop it; the user can re-enter.
      }
    }
  }

  /** Store a key for a provider; `persist` also saves it (encrypted) to disk. */
  set(providerId: string, key: string, persist: boolean): void {
    this.#rehydrate()
    this.#memory.set(providerId, key)
    if (persist && this.#enc.available) {
      this.#store.saveSecret(providerId, this.#enc.encrypt(key))
    }
  }

  get(providerId: string): string | undefined {
    this.#rehydrate()
    return this.#memory.get(providerId)
  }

  has(providerId: string): boolean {
    this.#rehydrate()
    return this.#memory.has(providerId)
  }

  clear(providerId: string): void {
    this.#memory.delete(providerId)
    this.#store.deleteSecret(providerId)
  }
}
