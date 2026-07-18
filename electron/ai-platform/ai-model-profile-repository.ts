// Model Profile repository.
//
// Stores AiModelProfile records under userData/ai/profiles.json. The raw API
// key is NEVER stored here — only the `credentialKey` that references the
// encrypted Credential Vault. Profiles returned to the renderer are the same
// records; no key field exists on AiModelProfile to leak.
//
// P0-1: a profile is now a MODEL entry under a supplier. The supplier owns
// base URL + protocol + credential + enable state. `listEnabled` /
// `getEnabled` exclude disabled profiles (and the runtime + Git AI use them
// so a disabled model can never be used for a new run, even though its
// history is preserved). `list` still returns all profiles (the settings page
// shows disabled ones greyed out; conversation history can still display a
// disabled profile's name).
//
// Schema v1 → v2: v1 profiles are normalized with enabled=true, protocol
// inherited from providerId, supplierId assigned by the supplier repository's
// migration. v2 profiles carry the fields natively.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  AI_PROFILE_SCHEMA_VERSION,
  type AiModelProfile,
  type AiProfileInput,
  type AiProtocol,
  type AiProviderId,
} from './ai-types.js'

export type { AiProfileInput } from './ai-types.js'

const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/
const VALID_DISPLAY_NAME = /^[\p{L}\p{N}\s\-_.:()/]{1,120}$/u

interface ProfileIndex {
  version: number
  profiles: AiModelProfile[]
}

/**
 * Provider ids the P0-1 main-process boundary actually implements. Widened
 * from P1 to include `anthropic` (served via the `anthropic-messages`
 * protocol). `google` remains reserved.
 */
export const P1_SUPPORTED_PROVIDERS: ReadonlySet<AiProviderId> = new Set([
  'openai-compatible',
  'ollama',
  'anthropic',
])

export class AiModelProfileRepository {
  private readonly indexPath: string
  private profiles: AiModelProfile[]
  /**
   * Aliases from a dropped-duplicate profile id to the canonical profile id
   * that absorbed it (see `readIndex` load-time merge). `get(aliasedId)`
   * redirects to the canonical record so a historical `modelProfileId`
   * pointing at a discarded duplicate still resolves for audit/history.
   */
  private readonly aliases: Map<string, string> = new Map()
  /**
   * P0-1: optional supplier repository. When set, `get`/`list`/`getEnabled`/
   * `listEnabled` merge the linked supplier's fields (protocol, baseUrl,
   * credentialKey) into each profile so the runtime + provider registry see a
   * fully-resolved profile. A profile whose supplier is disabled is treated
   * as disabled by `getEnabled`/`listEnabled` (the supplier's enable flag is
   * the master switch for all its models).
   */
  private suppliers: { get: (id: string) => { enabled: boolean; protocol: AiProtocol; baseUrl?: string; credentialKey: string } | null } | null = null

  constructor(dataDir: string) {
    const aiDir = path.join(dataDir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    this.indexPath = path.join(aiDir, 'profiles.json')
    this.profiles = this.readIndex()
  }

  /** P0-1: inject the supplier repository (called once at bootstrap). */
  setSupplierRepository(suppliers: AiModelProfileRepository['suppliers']): void {
    this.suppliers = suppliers
  }

  /**
   * P0-1: merge a profile with its linked supplier's fields. The supplier owns
   * connection config (protocol/baseUrl/credentialKey); the profile owns model
   * id + capabilities + per-model enable. Returns the merged profile, or null
   * if the profile references a disabled supplier (caller treats null as
   * "not usable for new runs").
   */
  private resolve(profile: AiModelProfile): AiModelProfile | null {
    if (!this.suppliers || !profile.supplierId) return profile
    const supplier = this.suppliers.get(profile.supplierId)
    if (!supplier) return profile // supplier gone: keep profile as-is (legacy)
    if (!supplier.enabled) return null // disabled supplier → not usable
    return {
      ...profile,
      // Supplier's connection config wins; profile's per-model override only
      // applies to protocol (rare). baseUrl + credentialKey always come from
      // the supplier so all models under it share one connection.
      protocol: profile.protocol ?? supplier.protocol,
      baseUrl: supplier.baseUrl ?? profile.baseUrl,
      credentialKey: supplier.credentialKey,
    }
  }

  list(): AiModelProfile[] {
    return this.profiles
      .map((p) => ({ ...p, capabilities: { ...p.capabilities } }))
      .map((p) => this.resolve(p) ?? { ...p, enabled: false, capabilities: { ...p.capabilities } })
  }

  /**
   * P0-1: profiles usable for NEW runs — enabled only AND supplier enabled.
   * The AI assistant dropdown and the supplier settings page's "active
   * models" use this. `list` (above) still returns ALL profiles so the
   * settings page can show disabled ones greyed out and conversation history
   * can resolve names.
   */
  listEnabled(): AiModelProfile[] {
    return this.profiles
      .filter((p) => p.enabled !== false)
      .map((p) => this.resolve(p))
      .filter((p): p is AiModelProfile => p !== null)
      .map((p) => ({ ...p, capabilities: { ...p.capabilities } }))
  }

  get(id: string): AiModelProfile | null {
    // Alias redirect: a historical `modelProfileId` may point at a duplicate
    // profile discarded by the load-time merge. Redirect to the canonical id
    // so conversation history / audit refs still resolve.
    const canonicalId = this.aliases.get(id) ?? id
    const found = this.profiles.find((p) => p.id === canonicalId)
    if (!found) return null
    // `get` is for display/history: return the profile even if its supplier is
    // disabled, so conversation history can still resolve a name. The runtime
    // uses `getEnabled` (which respects supplier enable) for new runs.
    const resolved = this.resolve(found)
    if (resolved) return { ...resolved, capabilities: { ...resolved.capabilities } }
    return { ...found, enabled: false, capabilities: { ...found.capabilities } }
  }

  /**
   * P0-1: profile usable for a NEW run — returns null when disabled OR when
   * its supplier is disabled. The runtime's runLoop + proposeCommitMessage
   * use this (NOT `get`) so a disabled model can never be used, even if a
   * stale conversation references it.
   */
  getEnabled(id: string): AiModelProfile | null {
    const p = this.get(id)
    if (!p) return null
    if (p.enabled === false) return null
    return p
  }

  upsert(input: AiProfileInput): AiModelProfile {
    const explicitId = input.id ? this.assertId(input.id) : undefined
    const now = Date.now()
    // P0-1 dedup: a no-id upsert whose (supplierId, model) matches an existing
    // profile collapses onto that profile instead of creating a duplicate.
    // This matches the supplier repo's fold philosophy and fixes the
    // regression where every "添加模型" click appended a new row, flooding the
    // AI dropdown with identical profiles (a real user hit 25 copies of
    // GLM-5.2 under TokenHub). An explicit id always wins — callers that pass
    // an id are targeting a specific profile and must never be redirected to a
    // twin.
    const existing = explicitId
      ? this.profiles.find((p) => p.id === explicitId)
      : this.findDuplicate(input.supplierId, input.model)
    const id = explicitId ?? existing?.id ?? `prof_${randomUUID()}`
    const providerId = this.assertProvider(input.providerId)
    const displayName = this.assertDisplayName(input.displayName)
    const model = input.model.trim().slice(0, 200)
    if (!model) throw new Error('模型名不能为空')
    const baseUrl = input.baseUrl?.trim().slice(0, 500) || undefined
    const credentialKey = this.assertId(input.credentialKey)
    const supplierId = input.supplierId ? this.assertId(input.supplierId) : existing?.supplierId
    const enabled = input.enabled ?? existing?.enabled ?? true
    const protocol = input.protocol ?? existing?.protocol
    const capabilities = {
      vision: input.capabilities?.vision ?? existing?.capabilities.vision ?? false,
      toolCalling: input.capabilities?.toolCalling ?? existing?.capabilities.toolCalling ?? false,
      jsonSchema: input.capabilities?.jsonSchema ?? existing?.capabilities.jsonSchema ?? false,
      reasoning: input.capabilities?.reasoning ?? existing?.capabilities.reasoning ?? false,
    }
    const profile: AiModelProfile = {
      id,
      providerId,
      displayName,
      model,
      baseUrl,
      credentialKey,
      // P0-1: only stamp supplierId/enabled/protocol when present so legacy
      // v1 profiles on disk aren't rewritten spuriously; they get normalized
      // on read instead.
      ...(supplierId ? { supplierId } : {}),
      enabled,
      ...(protocol ? { protocol } : {}),
      capabilities,
      maxInputTokens: input.maxInputTokens ?? existing?.maxInputTokens,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.profiles = existing
      ? this.profiles.map((p) => (p.id === id ? profile : p))
      : [profile, ...this.profiles]
    this.writeIndex()
    return { ...profile, capabilities: { ...profile.capabilities } }
  }

  /**
   * P0-1: toggle a profile's `enabled` flag in place, atomically. Unlike
   * `upsert`, this touches ONLY `enabled` + `updatedAt` — it never rewrites
   * model/displayName/baseUrl/credentialKey/supplierId, so a toggle can't
   * accidentally clobber supplier-owned fields or create a duplicate. The
   * settings page's per-model switch uses this (previously it re-upserted the
   * whole profile, which was both fragile and a duplicate risk). Atomic:
   * re-reads from disk on write failure so in-memory state never diverges.
   * Returns the updated profile, or null if the id is unknown.
   */
  setEnabled(id: string, enabled: boolean): AiModelProfile | null {
    this.assertId(id)
    const before = this.profiles.map((p) => ({ ...p }))
    const target = this.profiles.find((p) => p.id === id)
    if (!target) return null
    target.enabled = enabled
    target.updatedAt = Date.now()
    try {
      this.writeIndex()
    } catch (e) {
      // Roll back so a failed write does not leave the repository thinking
      // the profile is enabled when disk says otherwise.
      this.profiles = before
      throw e
    }
    return { ...target, capabilities: { ...target.capabilities } }
  }

  /**
   * P0-1: assign a supplierId to a profile in place (used by migration). Does
   * NOT bump updatedAt (it's a structural migration, not a user edit). Atomic
   * write. Safe to call repeatedly — a profile already carrying the same
   * supplierId is a no-op.
   */
  assignSupplier(id: string, supplierId: string): void {
    this.assertId(id)
    this.assertId(supplierId)
    const target = this.profiles.find((p) => p.id === id)
    if (!target) return
    if (target.supplierId === supplierId) return
    target.supplierId = supplierId
    this.writeIndex()
  }

  delete(id: string): boolean {
    this.assertId(id)
    const before = this.profiles.length
    this.profiles = this.profiles.filter((p) => p.id !== id)
    const deleted = this.profiles.length < before
    if (deleted) this.writeIndex()
    return deleted
  }

  /** Delete every model owned by a supplier in one atomic profile-index write. */
  deleteBySupplier(supplierId: string): number {
    this.assertId(supplierId)
    const before = this.profiles.length
    const next = this.profiles.filter((p) => p.supplierId !== supplierId)
    const deleted = before - next.length
    if (deleted === 0) return 0
    this.profiles = next
    this.writeIndex()
    return deleted
  }

  private readIndex(): AiModelProfile[] {
    let raw: AiModelProfile[]
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as ProfileIndex
      if (!Array.isArray(parsed.profiles)) return []
      // Accept v1 (legacy) and v2 (P0-1 with supplierId/enabled/protocol).
      // Both are normalized to the same in-memory shape below.
      raw = parsed.profiles
        .filter((p) => VALID_ID.test(p.id) && P1_SUPPORTED_PROVIDERS.has(p.providerId))
        .map((p) => ({
          id: p.id,
          providerId: p.providerId,
          displayName: typeof p.displayName === 'string' ? p.displayName.slice(0, 120) : '未命名',
          model: typeof p.model === 'string' ? p.model.slice(0, 200) : '',
          baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.slice(0, 500) : undefined,
          credentialKey: VALID_ID.test(p.credentialKey) ? p.credentialKey : '',
          // P0-1: supplierId optional (legacy v1 profiles get it during
          // supplier migration). enabled absent → true. protocol optional.
          ...(typeof p.supplierId === 'string' && VALID_ID.test(p.supplierId) ? { supplierId: p.supplierId } : {}),
          enabled: p.enabled !== false,
          ...(p.protocol ? { protocol: p.protocol as AiProtocol } : {}),
          capabilities: {
            vision: Boolean(p.capabilities?.vision),
            toolCalling: Boolean(p.capabilities?.toolCalling),
            jsonSchema: Boolean(p.capabilities?.jsonSchema),
            reasoning: Boolean(p.capabilities?.reasoning),
          },
          maxInputTokens: typeof p.maxInputTokens === 'number' ? p.maxInputTokens : undefined,
          createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
          updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
        }))
    } catch {
      return []
    }
    return this.mergeDuplicates(raw)
  }

  /**
   * P0-1: collapse duplicate profiles sharing a (supplierId, model) twin into
   * ONE canonical record. The earliest `createdAt` wins (preserves the
   * original); later duplicates are dropped and their ids registered as
   * aliases pointing at the canonical id, so a historical `modelProfileId`
   * referencing a discarded duplicate still resolves via `get`. This runs at
   * load time so the existing 25-copy GLM-5.2 regression self-heals on the
   * next start without a manual cleanup script. The merged result is also
   * what gets persisted on the next write, so the disk file converges.
   *
   * Profiles with no supplierId are never merged (legacy v1 profiles without
   * a supplier link are left as-is; the supplier migration assigns them one).
   */
  private mergeDuplicates(profiles: AiModelProfile[]): AiModelProfile[] {
    // byDedupKey: (supplierId|model) → the canonical profile for that twin.
    // byId: profile id → canonical profile (so the final ordering pass can
    // look up by id after aliases redirect dropped ids to canonical ids).
    const byDedupKey = new Map<string, AiModelProfile>()
    const byId = new Map<string, AiModelProfile>()
    for (const p of profiles) {
      if (!p.supplierId) {
        // No dedup key — keep as-is.
        byId.set(p.id, p)
        continue
      }
      const key = `${p.supplierId}|${p.model}`
      const current = byDedupKey.get(key)
      if (!current) {
        byDedupKey.set(key, p)
        byId.set(p.id, p)
        continue
      }
      // Twin exists: keep the earliest createdAt, register the other as alias
      // pointing at the keeper. The keeper's id slot in byId is updated if we
      // swapped; the dropped id is removed from byId (it resolves via alias).
      const [keep, drop] = p.createdAt < current.createdAt ? [p, current] : [current, p]
      byDedupKey.set(key, keep)
      // If we swapped keepers, fix up byId: drop the old keeper's id, set the
      // new keeper's id.
      if (keep.id !== current.id) {
        byId.delete(current.id)
        byId.set(keep.id, keep)
        // The old keeper is now a drop — alias it to the new keeper.
        this.aliases.set(current.id, keep.id)
      }
      if (drop.id !== keep.id) {
        byId.delete(drop.id)
        this.aliases.set(drop.id, keep.id)
      }
    }
    // Preserve original ordering (first-seen) for stable UI display. A profile
    // whose id was dropped (aliased) is skipped; its canonical twin appears at
    // the first-seen position of either.
    const seen = new Set<string>()
    const result: AiModelProfile[] = []
    for (const p of profiles) {
      const canonicalId = this.aliases.get(p.id) ?? p.id
      if (seen.has(canonicalId)) continue
      seen.add(canonicalId)
      const canonical = byId.get(canonicalId)
      if (canonical) result.push(canonical)
    }
    return result
  }

  /**
   * P0-1: find an existing profile with the same (supplierId, model) — the
   * dedup key used by `upsert`. A profile with no supplierId never matches
   * (it has no dedup key). Used to collapse a no-id "add model" click onto
   * the existing twin instead of creating a duplicate.
   */
  private findDuplicate(supplierId: string | undefined, model: string): AiModelProfile | undefined {
    const trimmed = model.trim()
    if (!trimmed || !supplierId) return undefined
    return this.profiles.find((p) =>
      p.supplierId === supplierId && p.model === trimmed,
    )
  }

  private writeIndex(): void {
    const payload: ProfileIndex = {
      version: AI_PROFILE_SCHEMA_VERSION,
      profiles: this.profiles,
    }
    mkdirSync(path.dirname(this.indexPath), { recursive: true })
    const temp = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.indexPath)
  }

  private assertId(id: string): string {
    if (!VALID_ID.test(id)) throw new Error('非法配置 ID')
    return id
  }

  private assertProvider(providerId: AiProviderId): AiProviderId {
    if (!P1_SUPPORTED_PROVIDERS.has(providerId)) {
      throw new Error(`暂不支持该 provider：${providerId}（openai-compatible / ollama / anthropic）`)
    }
    return providerId
  }

  private assertDisplayName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed || !VALID_DISPLAY_NAME.test(trimmed)) {
      throw new Error('显示名仅支持字母、数字、空格及 -_.:()/ 且长度 1-120')
    }
    return trimmed.slice(0, 120)
  }
}
