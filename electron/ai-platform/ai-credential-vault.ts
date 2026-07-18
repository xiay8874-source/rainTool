// Encrypted Credential Vault for AI provider API keys.
//
// Hard rules (plan §4.3, P0 spike §5.2):
//   1. Keys are encrypted with Electron safeStorage before touching disk.
//   2. If safeStorage.isEncryptionAvailable() is false, saving is DISABLED.
//      There is NO plaintext fallback — a false result means "no saved keys".
//   3. The raw key is never returned to the renderer, never written to logs,
//      never serialized into conversation JSON, and never included in errors.
//   4. The renderer only ever sees AiCredentialStatus (maskedPreview shows at
//      most the first and last 2 characters; the middle is always hidden).
//
// The vault file lives under app.getPath('userData')/ai/credentials.json and
// is written atomically with mode 0600. Even if the file were copied off this
// machine, the ciphertext is unusable without this OS user's keychain.

import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const VALID_CREDENTIAL_KEY = /^[A-Za-z0-9_-]{1,128}$/

interface VaultFile {
  version: number
  /** credentialKey -> base64 ciphertext blob from safeStorage.encryptString */
  entries: Record<string, string>
}

const VAULT_VERSION = 1

export class AiCredentialVault {
  private readonly vaultPath: string
  private entries: Record<string, string>

  constructor(dataDir: string) {
    const aiDir = path.join(dataDir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    this.vaultPath = path.join(aiDir, 'credentials.json')
    this.entries = this.readVault()
  }

  /** Whether safeStorage can encrypt on this machine. Drives the save gate. */
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Store a key. Returns `encryption-unavailable` (no save) when safeStorage
   * cannot encrypt — the renderer surfaces this; we never write plaintext.
   */
  set(credentialKey: string, rawKey: string): { ok: true } | { ok: false; reason: 'encryption-unavailable' } {
    this.assertKey(credentialKey)
    const trimmed = rawKey.trim()
    if (!trimmed) {
      // Empty input deletes any existing entry; not an error.
      delete this.entries[credentialKey]
      this.writeVault()
      return { ok: true }
    }
    if (!this.isEncryptionAvailable()) {
      return { ok: false, reason: 'encryption-unavailable' }
    }
    const ciphertext = safeStorage.encryptString(trimmed).toString('base64')
    this.entries[credentialKey] = ciphertext
    this.writeVault()
    return { ok: true }
  }

  /**
   * Retrieve a raw key for main-process use only. Returns `null` when absent
   * or when encryption was lost (ciphertext cannot be decrypted). Never throws
   * the key into an error message.
   */
  get(credentialKey: string): string | null {
    this.assertKey(credentialKey)
    const blob = this.entries[credentialKey]
    if (!blob) return null
    if (!this.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'))
    } catch {
      // Keychain changed or blob corrupted. Treat as unavailable; do not leak.
      return null
    }
  }

  /** Delete a credential. No-op if absent. */
  delete(credentialKey: string): void {
    this.assertKey(credentialKey)
    if (this.entries[credentialKey]) {
      delete this.entries[credentialKey]
      this.writeVault()
    }
  }

  /**
   * Masked status for the renderer. configured=false hides the preview
   * entirely. maskedPreview shows only first/last 2 chars with a fixed-width
   * mask between, so the length leaked is bounded and constant.
   */
  status(credentialKey: string): {
    credentialKey: string
    configured: boolean
    maskedPreview?: string
    encryptionAvailable: boolean
  } {
    this.assertKey(credentialKey)
    const configured = Boolean(this.entries[credentialKey])
    return {
      credentialKey,
      configured,
      maskedPreview: configured ? this.mask(this.get(credentialKey)) : undefined,
      encryptionAvailable: this.isEncryptionAvailable(),
    }
  }

  /** Delete ALL credentials (used by "delete conversation + local data"). */
  clear(): void {
    this.entries = {}
    this.writeVault()
  }

  private mask(raw: string | null): string | undefined {
    if (!raw) return undefined
    if (raw.length <= 4) return '••••'
    return `${raw.slice(0, 2)}••••${raw.slice(-2)}`
  }

  private assertKey(credentialKey: string): void {
    if (!VALID_CREDENTIAL_KEY.test(credentialKey)) {
      throw new Error('非法凭据键名')
    }
  }

  private readVault(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.vaultPath, 'utf8')) as VaultFile
      if (parsed.version !== VAULT_VERSION || typeof parsed.entries !== 'object') return {}
      const entries: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (VALID_CREDENTIAL_KEY.test(key) && typeof value === 'string') {
          entries[key] = value
        }
      }
      return entries
    } catch {
      return {}
    }
  }

  private writeVault(): void {
    const payload: VaultFile = { version: VAULT_VERSION, entries: this.entries }
    this.atomicWrite(this.vaultPath, JSON.stringify(payload, null, 2))
  }

  private atomicWrite(file: string, contents: string): void {
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  }
}

/** Generate a new credential key (caller assigns it to a profile). */
export function newCredentialKey(): string {
  return `cred_${randomUUID()}`
}
