// Model Profile repository.
//
// Stores AiModelProfile records under userData/ai/profiles.json. The raw API
// key is NEVER stored here — only the `credentialKey` that references the
// encrypted Credential Vault. Profiles returned to the renderer are the same
// records; no key field exists on AiModelProfile to leak.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  AI_PROFILE_SCHEMA_VERSION,
  type AiModelProfile,
  type AiProfileInput,
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
 * Provider ids the P1 main-process boundary actually implements. The
 * `AiProviderId` union keeps anthropic/google for forward compatibility, but
 * P1 ships no provider adapter for them — upsert rejects them, and legacy
 * profiles with an unsupported providerId are filtered out on load so they
 * never reach the runtime/UI. P2+ widens this set when adapters ship.
 */
export const P1_SUPPORTED_PROVIDERS: ReadonlySet<AiProviderId> = new Set([
  'openai-compatible',
  'ollama',
])

export class AiModelProfileRepository {
  private readonly indexPath: string
  private profiles: AiModelProfile[]

  constructor(dataDir: string) {
    const aiDir = path.join(dataDir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    this.indexPath = path.join(aiDir, 'profiles.json')
    this.profiles = this.readIndex()
  }

  list(): AiModelProfile[] {
    return this.profiles.map((p) => ({ ...p, capabilities: { ...p.capabilities } }))
  }

  get(id: string): AiModelProfile | null {
    const found = this.profiles.find((p) => p.id === id)
    return found ? { ...found, capabilities: { ...found.capabilities } } : null
  }

  upsert(input: AiProfileInput): AiModelProfile {
    const id = input.id ? this.assertId(input.id) : `prof_${randomUUID()}`
    const now = Date.now()
    const existing = this.profiles.find((p) => p.id === id)
    const providerId = this.assertProvider(input.providerId)
    const displayName = this.assertDisplayName(input.displayName)
    const model = input.model.trim().slice(0, 200)
    if (!model) throw new Error('模型名不能为空')
    const baseUrl = input.baseUrl?.trim().slice(0, 500) || undefined
    const credentialKey = this.assertId(input.credentialKey)
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

  delete(id: string): boolean {
    this.assertId(id)
    const before = this.profiles.length
    this.profiles = this.profiles.filter((p) => p.id !== id)
    const deleted = this.profiles.length < before
    if (deleted) this.writeIndex()
    return deleted
  }

  private readIndex(): AiModelProfile[] {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as ProfileIndex
      if (parsed.version !== AI_PROFILE_SCHEMA_VERSION || !Array.isArray(parsed.profiles)) return []
      return parsed.profiles
        .filter((p) => VALID_ID.test(p.id) && P1_SUPPORTED_PROVIDERS.has(p.providerId))
        .map((p) => ({
          id: p.id,
          providerId: p.providerId,
          displayName: typeof p.displayName === 'string' ? p.displayName.slice(0, 120) : '未命名',
          model: typeof p.model === 'string' ? p.model.slice(0, 200) : '',
          baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.slice(0, 500) : undefined,
          credentialKey: VALID_ID.test(p.credentialKey) ? p.credentialKey : '',
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
      throw new Error(`P1 暂不支持该 provider：${providerId}（仅 openai-compatible / ollama）`)
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
