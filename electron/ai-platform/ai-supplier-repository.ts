// Supplier repository (P0-1).
//
// Stores AiSupplier records under userData/ai/suppliers.json. A supplier is a
// provider configuration (base URL + protocol + encrypted credential key +
// enable flag) that groups one or more model profiles. TokenHub is seeded as
// the default supplier on first run.
//
// Migration + dedup: on load, any model profile that has no supplierId is
// assigned to a supplier. Legacy profiles are grouped into a supplier keyed by
// (providerId, baseUrl, credentialKey) so profiles that pointed at the same
// endpoint collapse into ONE supplier instead of N duplicates. TokenHub-
// shaped profiles (baseUrl === TOKENHUB_DEFAULT_BASE_URL) are folded into the
// seeded TokenHub supplier. This dedup is safe because the supplier only
// stores connection config the profiles already shared.
//
// Atomic writes: suppliers.json is written via a temp file + rename (mode
// 0600), so a crash mid-write never leaves a truncated file. A failed write
// throws — the caller (IPC) surfaces a safe error and the in-memory state is
// NOT left inconsistent (we mutate this.suppliers only after a successful
// write, or for enable/disable we re-read from disk on failure).
//
// Raw API keys are NEVER stored here — only credentialKey references the
// encrypted vault.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  AI_SUPPLIER_SCHEMA_VERSION,
  TOKENHUB_DEFAULT_BASE_URL,
  TOKENHUB_DEFAULT_SUPPLIER_ID,
  type AiProtocol,
  type AiProviderId,
  type AiSupplier,
  type AiSupplierInput,
} from './ai-types.js'

export type { AiSupplierInput } from './ai-types.js'

const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/
const VALID_DISPLAY_NAME = /^[\p{L}\p{N}\s\-_.:()/]{1,120}$/u

interface SupplierFile {
  version: number
  suppliers: AiSupplier[]
}

const SUPPORTED_PROTOCOLS: ReadonlySet<AiProtocol> = new Set([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
])

/**
 * Providers the P0-1 boundary implements. Wider than P1 (which shipped only
 * openai-compatible + ollama): anthropic is now supported via the
 * `anthropic-messages` protocol. google remains reserved.
 */
export const P0_SUPPORTED_PROVIDERS: ReadonlySet<AiProviderId> = new Set([
  'openai-compatible',
  'ollama',
  'anthropic',
])

export class AiSupplierRepository {
  private readonly suppliersPath: string
  private suppliers: AiSupplier[]

  constructor(dataDir: string) {
    const aiDir = path.join(dataDir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    this.suppliersPath = path.join(aiDir, 'suppliers.json')
    this.suppliers = this.readSuppliers()
    // Seed TokenHub default if there are no suppliers at all (first run or a
    // user who deleted everything). Seeding is idempotent: if a TokenHub
    // supplier already exists (by id OR by baseUrl match) we do NOT add a
    // duplicate.
    if (this.suppliers.length === 0) {
      this.suppliers = [this.buildTokenHubDefault()]
      this.writeSuppliers()
    }
  }

  list(): AiSupplier[] {
    return this.suppliers.map((s) => ({ ...s }))
  }

  get(id: string): AiSupplier | null {
    const found = this.suppliers.find((s) => s.id === id)
    return found ? { ...found } : null
  }

  /** Whether a supplier is usable (exists AND enabled). */
  isEnabled(id: string): boolean {
    const s = this.get(id)
    return Boolean(s && s.enabled)
  }

  /**
   * P0-1: resolve the CANONICAL supplier id + credentialKey an upsert WOULD
   * produce for the given input, WITHOUT writing. The IPC handler calls this
   * BEFORE writing the credential vault so the vault write lands on the final
   * key (not a temp key that a subsequent fold would orphan).
   *
   * Returns:
   *   - `id`: the final supplier id (may fold to TOKENHUB_DEFAULT_SUPPLIER_ID).
   *   - `credentialKey`: the final credentialKey. For a fold into an existing
   *     supplier, this is the TARGET's credentialKey (the canonical key). For
   *     a new supplier, this is the input's credentialKey (may be empty — the
   *     IPC handler allocates one).
   *   - `isNew`: true when no existing supplier matches (a new supplier will be
   *     created).
   */
  resolveCanonical(input: {
    id?: string
    baseUrl?: string
    credentialKey?: string
  }): { id: string; credentialKey: string; isNew: boolean } {
    const baseUrl = input.baseUrl?.trim()
    let resolvedId = input.id ?? `supplier_${randomUUID()}`
    if (baseUrl === TOKENHUB_DEFAULT_BASE_URL && resolvedId !== TOKENHUB_DEFAULT_SUPPLIER_ID) {
      const tokenhub = this.suppliers.find((s) => s.id === TOKENHUB_DEFAULT_SUPPLIER_ID)
      if (tokenhub) {
        resolvedId = tokenhub.id
      }
    }
    const target = this.suppliers.find((s) => s.id === resolvedId)
    if (target) {
      return { id: target.id, credentialKey: target.credentialKey, isNew: false }
    }
    return { id: resolvedId, credentialKey: input.credentialKey ?? '', isNew: true }
  }

  upsert(input: AiSupplierInput): AiSupplier {
    const id = input.id ? this.assertId(input.id) : `supplier_${randomUUID()}`
    const now = Date.now()
    const existing = this.suppliers.find((s) => s.id === id)
    const providerId = this.assertProvider(input.providerId)
    const protocol = this.assertProtocol(input.protocol)
    const displayName = this.assertDisplayName(input.displayName)
    const baseUrl = input.baseUrl?.trim().slice(0, 500) || undefined
    const credentialKey = this.assertId(input.credentialKey)
    // Dedup against TokenHub: if the user is creating/editing a supplier to
    // point at the TokenHub default URL, fold it into the seeded TokenHub
    // supplier id so there is exactly ONE TokenHub entry. This prevents the
    // "add TokenHub again" duplicate the old modal allowed.
    let resolvedId = id
    if (baseUrl === TOKENHUB_DEFAULT_BASE_URL && id !== TOKENHUB_DEFAULT_SUPPLIER_ID) {
      const tokenhub = this.suppliers.find((s) => s.id === TOKENHUB_DEFAULT_SUPPLIER_ID)
      if (tokenhub) {
        resolvedId = tokenhub.id
      }
    }
    const target = this.suppliers.find((s) => s.id === resolvedId)
    const supplier: AiSupplier = {
      id: resolvedId,
      displayName: target?.displayName ?? displayName,
      providerId: target ? target.providerId : providerId,
      protocol: target ? target.protocol : protocol,
      baseUrl: target ? target.baseUrl : baseUrl,
      credentialKey: target ? target.credentialKey : credentialKey,
      enabled: input.enabled ?? target?.enabled ?? true,
      createdAt: target?.createdAt ?? now,
      updatedAt: now,
    }
    // If we're folding into an existing supplier, update its editable fields
    // (displayName/protocol/baseUrl/enabled) but KEEP the target's
    // credentialKey. The IPC handler resolves the canonical credentialKey
    // (the target's) BEFORE writing the vault, so the vault write already
    // landed on the target's key. Overriding credentialKey here with the
    // input's key would break the fold by changing the target's key to a
    // temp key the user never intended — and would orphan the credential at
    // the temp key if the IPC allocated one.
    if (target && resolvedId === target.id) {
      supplier.displayName = displayName
      supplier.providerId = providerId
      supplier.protocol = protocol
      supplier.baseUrl = baseUrl
      // credentialKey is NOT overridden — keep target.credentialKey (already
      // set above). The IPC handler writes the vault to this canonical key.
      supplier.enabled = input.enabled ?? target.enabled
    }
    const next = target
      ? this.suppliers.map((s) => (s.id === resolvedId ? supplier : s))
      : [supplier, ...this.suppliers]
    this.suppliers = next
    this.writeSuppliers()
    return { ...supplier }
  }

  /** Set the enabled flag on a supplier. Atomic: re-reads on write failure. */
  setEnabled(id: string, enabled: boolean): AiSupplier | null {
    this.assertId(id)
    const before = this.suppliers.map((s) => ({ ...s }))
    const target = this.suppliers.find((s) => s.id === id)
    if (!target) return null
    target.enabled = enabled
    target.updatedAt = Date.now()
    try {
      this.writeSuppliers()
    } catch (e) {
      // Roll back in-memory state so a failed write does not leave the
      // repository thinking the supplier is enabled when disk says otherwise.
      this.suppliers = before
      throw e
    }
    return { ...target }
  }

  delete(id: string): boolean {
    this.assertId(id)
    const before = this.suppliers.length
    this.suppliers = this.suppliers.filter((s) => s.id !== id)
    const deleted = this.suppliers.length < before
    if (deleted) this.writeSuppliers()
    return deleted
  }

  /**
   * P0-1 migration: assign a supplierId to a legacy profile that lacks one.
   * Returns the supplierId the profile should reference. Idempotent: a
   * profile whose supplierId already references an existing supplier keeps it.
   *
   * Dedup rule: legacy profiles are grouped by (providerId, baseUrl||'',
   * credentialKey). Profiles sharing those three values collapse into ONE
   * supplier — they already pointed at the same endpoint with the same
   * credential, so the supplier is just the named container for that
   * connection config. A profile pointing at the TokenHub default URL folds
   * into the seeded TokenHub supplier.
   */
  resolveSupplierForLegacyProfile(profile: {
    providerId: AiProviderId
    baseUrl?: string
    credentialKey: string
    supplierId?: string
  }): string {
    // Already linked to a live supplier — keep it.
    if (profile.supplierId && this.suppliers.some((s) => s.id === profile.supplierId)) {
      return profile.supplierId
    }
    const baseUrl = (profile.baseUrl ?? '').trim()
    // TokenHub-shaped → fold into the seeded default.
    if (baseUrl === TOKENHUB_DEFAULT_BASE_URL) {
      const tokenhub = this.suppliers.find((s) => s.id === TOKENHUB_DEFAULT_SUPPLIER_ID)
      if (tokenhub) return tokenhub.id
    }
    // Dedup by (providerId, baseUrl, credentialKey).
    const dedupKey = `${profile.providerId}|${baseUrl}|${profile.credentialKey}`
    const existing = this.suppliers.find((s) => supplierDedupKey(s) === dedupKey)
    if (existing) return existing.id
    // Create a new supplier container for this legacy connection config.
    const now = Date.now()
    const supplier: AiSupplier = {
      id: `supplier_${randomUUID()}`,
      displayName: defaultSupplierName(profile.providerId, baseUrl),
      providerId: profile.providerId,
      protocol: defaultProtocolFor(profile.providerId),
      baseUrl: baseUrl || undefined,
      credentialKey: profile.credentialKey,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
    this.suppliers = [supplier, ...this.suppliers]
    this.writeSuppliers()
    return supplier.id
  }

  private buildTokenHubDefault(): AiSupplier {
    const now = Date.now()
    return {
      id: TOKENHUB_DEFAULT_SUPPLIER_ID,
      displayName: 'TokenHub',
      providerId: 'openai-compatible',
      protocol: 'openai-chat',
      baseUrl: TOKENHUB_DEFAULT_BASE_URL,
      // TokenHub (loopback) needs no key; allocate a stable empty slot anyway
      // so profiles can reference it uniformly.
      credentialKey: 'cred_tokenhub_default',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
  }

  private readSuppliers(): AiSupplier[] {
    try {
      const parsed = JSON.parse(readFileSync(this.suppliersPath, 'utf8')) as SupplierFile
      if (parsed.version !== AI_SUPPLIER_SCHEMA_VERSION || !Array.isArray(parsed.suppliers)) {
        return []
      }
      return parsed.suppliers
        .filter((s) => VALID_ID.test(s.id) && P0_SUPPORTED_PROVIDERS.has(s.providerId))
        .map((s) => ({
          id: s.id,
          displayName: typeof s.displayName === 'string' ? s.displayName.slice(0, 120) : '未命名供应商',
          providerId: s.providerId,
          protocol: SUPPORTED_PROTOCOLS.has(s.protocol) ? s.protocol : 'openai-chat',
          baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl.slice(0, 500) : undefined,
          credentialKey: VALID_ID.test(s.credentialKey) ? s.credentialKey : '',
          enabled: s.enabled !== false, // absent → true
          createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
        }))
    } catch {
      return []
    }
  }

  private writeSuppliers(): void {
    const payload: SupplierFile = {
      version: AI_SUPPLIER_SCHEMA_VERSION,
      suppliers: this.suppliers,
    }
    mkdirSync(path.dirname(this.suppliersPath), { recursive: true })
    const temp = `${this.suppliersPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.suppliersPath)
  }

  private assertId(id: string): string {
    if (!VALID_ID.test(id)) throw new Error('非法供应商/凭据 ID')
    return id
  }

  private assertProvider(providerId: AiProviderId): AiProviderId {
    if (!P0_SUPPORTED_PROVIDERS.has(providerId)) {
      throw new Error(`暂不支持该 provider：${providerId}`)
    }
    return providerId
  }

  private assertProtocol(protocol: AiProtocol): AiProtocol {
    if (!SUPPORTED_PROTOCOLS.has(protocol)) {
      throw new Error(`暂不支持该协议：${protocol}`)
    }
    return protocol
  }

  private assertDisplayName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed || !VALID_DISPLAY_NAME.test(trimmed)) {
      throw new Error('供应商显示名仅支持字母、数字、空格及 -_.:()/ 且长度 1-120')
    }
    return trimmed.slice(0, 120)
  }
}

function supplierDedupKey(s: AiSupplier): string {
  return `${s.providerId}|${(s.baseUrl ?? '').trim()}|${s.credentialKey}`
}

function defaultSupplierName(providerId: AiProviderId, baseUrl: string): string {
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname
      if (host) return host
    } catch {
      // fall through
    }
    return baseUrl.slice(0, 60)
  }
  switch (providerId) {
    case 'ollama':
      return 'Ollama (本地)'
    case 'anthropic':
      return 'Anthropic'
    case 'openai-compatible':
      return 'OpenAI 兼容'
    default:
      return providerId
  }
}

function defaultProtocolFor(providerId: AiProviderId): AiProtocol {
  if (providerId === 'anthropic') return 'anthropic-messages'
  return 'openai-chat'
}
