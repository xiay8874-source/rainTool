// Conversation repository with schemaVersion migration.
//
// Stores one JSON file per conversation under userData/ai/conversations/<id>.json
// and an index at userData/ai/conversations/index.json. Messages persist text
// only — never raw keys, never ephemeral attachment content (P2+ concern).
//
// schemaVersion gates forward migration: load() runs a migrate() chain so an
// older file is upgraded in memory before use and re-persisted on next save.

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  AI_CONVERSATION_SCHEMA_VERSION,
  type AiConversation,
  type AiConversationSummary,
  type AiMessage,
  type AiMessageRole,
  type AiRunAuditRef,
  type AiRunMode,
} from './ai-types.js'

const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/
const MAX_MESSAGE_TEXT_BYTES = 256 * 1024
const MAX_RUN_AUDIT_REFS = 200

interface ConversationIndex {
  version: number
  items: AiConversationSummary[]
}

interface RawConversation {
  schemaVersion?: number
  id?: unknown
  title?: unknown
  modelProfileId?: unknown
  mode?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  messages?: unknown
  runAuditRefs?: unknown
}

export interface AiCreateConversationInput {
  title?: string
  modelProfileId: string
  mode?: AiRunMode
}

export class AiConversationRepository {
  private readonly rootDir: string
  private readonly indexPath: string
  private items: AiConversationSummary[]

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, 'ai', 'conversations')
    mkdirSync(this.rootDir, { recursive: true })
    this.indexPath = path.join(this.rootDir, 'index.json')
    this.items = this.readIndex()
  }

  list(): AiConversationSummary[] {
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): AiConversation | null {
    this.assertId(id)
    const file = this.conversationPath(id)
    if (!existsSync(file)) return null
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as RawConversation
      const migrated = this.migrate(raw)
      return migrated
    } catch {
      return null
    }
  }

  create(input: AiCreateConversationInput): AiConversation {
    const id = `conv_${randomUUID()}`
    const now = Date.now()
    const conversation: AiConversation = {
      schemaVersion: AI_CONVERSATION_SCHEMA_VERSION,
      id,
      title: this.sanitizeTitle(input.title),
      modelProfileId: this.assertId(input.modelProfileId),
      mode: input.mode ?? 'chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
      runAuditRefs: [],
    }
    this.writeConversation(conversation)
    this.items = [{ ...conversation, messageCount: 0 }, ...this.items]
    this.writeIndex()
    return conversation
  }

  /** Append a message and update the summary. Used by the runtime + IPC. */
  appendMessage(id: string, message: Omit<AiMessage, 'id'> & { id?: string }): AiMessage {
    const conversation = this.require(id)
    const full: AiMessage = {
      id: message.id ?? `msg_${randomUUID()}`,
      role: this.sanitizeRole(message.role),
      at: message.at,
      text: this.sanitizeText(message.text),
      modelProfileId: message.modelProfileId,
      runId: message.runId,
    }
    const messages = [...conversation.messages, full]
    const title = conversation.messages.length === 0 && full.role === 'user'
      ? this.titleFromText(full.text)
      : conversation.title
    const updated: AiConversation = {
      ...conversation,
      title,
      messages,
      updatedAt: Date.now(),
    }
    this.writeConversation(updated)
    this.updateSummary(updated)
    return full
  }

  /** Record a run audit ref (capped). No keys, no full payloads. */
  recordRunAudit(id: string, ref: AiRunAuditRef): void {
    const conversation = this.require(id)
    const refs = [ref, ...conversation.runAuditRefs].slice(0, MAX_RUN_AUDIT_REFS)
    const updated: AiConversation = { ...conversation, runAuditRefs: refs, updatedAt: Date.now() }
    this.writeConversation(updated)
    this.updateSummary(updated)
  }

  delete(id: string): boolean {
    this.assertId(id)
    const file = this.conversationPath(id)
    let deleted = false
    if (existsSync(file)) {
      try { unlinkSync(file) } catch { /* ignore */ }
      deleted = true
    }
    const before = this.items.length
    this.items = this.items.filter((item) => item.id !== id)
    if (this.items.length < before) {
      deleted = true
      this.writeIndex()
    }
    return deleted
  }

  setTitle(id: string, title: string): AiConversation | null {
    const conversation = this.require(id)
    const updated: AiConversation = {
      ...conversation,
      title: this.sanitizeTitle(title) || conversation.title,
      updatedAt: Date.now(),
    }
    this.writeConversation(updated)
    this.updateSummary(updated)
    return updated
  }

  private require(id: string): AiConversation {
    const conversation = this.get(id)
    if (!conversation) throw new Error(`会话不存在：${id}`)
    return conversation
  }

  /**
   * Migration chain. Each step upgrades from schemaVersion N to N+1.
   * Currently only v1 exists; this is the extension point for future bumps.
   */
  private migrate(raw: RawConversation): AiConversation {
    let version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
    let current: RawConversation = raw
    // Future: if (version === 0) { current = migrate0to1(current); version = 1 }
    if (version > AI_CONVERSATION_SCHEMA_VERSION) {
      // Newer than we understand: refuse to load (do not silently drop).
      throw new Error(`会话 schemaVersion ${version} 高于本程序支持的 ${AI_CONVERSATION_SCHEMA_VERSION}`)
    }
    if (version < AI_CONVERSATION_SCHEMA_VERSION) {
      // No migrators yet beyond v1; treat unknown/0 as v1 after normalization.
      version = AI_CONVERSATION_SCHEMA_VERSION
    }
    const id = typeof current.id === 'string' && VALID_ID.test(current.id) ? current.id : ''
    if (!id) throw new Error('会话缺少合法 ID')
    const messages = Array.isArray(current.messages) ? current.messages : []
    return {
      schemaVersion: AI_CONVERSATION_SCHEMA_VERSION,
      id,
      title: this.sanitizeTitle(typeof current.title === 'string' ? current.title : ''),
      modelProfileId: typeof current.modelProfileId === 'string' && VALID_ID.test(current.modelProfileId)
        ? current.modelProfileId : '',
      mode: this.sanitizeMode(current.mode),
      createdAt: typeof current.createdAt === 'number' ? current.createdAt : Date.now(),
      updatedAt: typeof current.updatedAt === 'number' ? current.updatedAt : Date.now(),
      messages: messages
        .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
        .map((m) => ({
          id: typeof m.id === 'string' ? m.id : `msg_${randomUUID()}`,
          role: this.sanitizeRole(m.role),
          at: typeof m.at === 'number' ? m.at : Date.now(),
          text: this.sanitizeText(typeof m.text === 'string' ? m.text : ''),
          modelProfileId: typeof m.modelProfileId === 'string' ? m.modelProfileId : undefined,
          runId: typeof m.runId === 'string' ? m.runId : undefined,
        })),
      runAuditRefs: Array.isArray(current.runAuditRefs)
        ? current.runAuditRefs
            .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
            .map((r) => ({
              runId: typeof r.runId === 'string' ? r.runId : '',
              startedAt: typeof r.startedAt === 'number' ? r.startedAt : Date.now(),
              endedAt: typeof r.endedAt === 'number' ? r.endedAt : undefined,
              modelProfileId: typeof r.modelProfileId === 'string' ? r.modelProfileId : '',
              status: (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'
                ? r.status : 'failed') as AiRunAuditRef['status'],
              redactedError: typeof r.redactedError === 'string' ? r.redactedError : undefined,
            }))
            .filter((r) => r.runId && r.modelProfileId)
        : [],
    }
  }

  private sanitizeTitle(title: string | undefined): string {
    const normalized = (title ?? '').trim().replace(/[\u0000-\u001f]/g, '')
    return (normalized || '新会话').slice(0, 200)
  }

  private sanitizeText(text: string): string {
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_TEXT_BYTES) {
      return text.slice(0, MAX_MESSAGE_TEXT_BYTES) + '\n[消息过长已截断]'
    }
    return text
  }

  private sanitizeRole(role: unknown): AiMessageRole {
    return role === 'user' || role === 'assistant' || role === 'system' || role === 'tool'
      ? role
      : 'user'
  }

  private sanitizeMode(mode: unknown): AiRunMode {
    return mode === 'assistant' || mode === 'agent' ? mode : 'chat'
  }

  private titleFromText(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim()
    return clean.slice(0, 40) || '新会话'
  }

  private conversationPath(id: string): string {
    return path.join(this.rootDir, `${id}.json`)
  }

  private updateSummary(conversation: AiConversation): void {
    const summary: AiConversationSummary = {
      id: conversation.id,
      title: conversation.title,
      modelProfileId: conversation.modelProfileId,
      mode: conversation.mode,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
    }
    this.items = this.items.some((item) => item.id === summary.id)
      ? this.items.map((item) => (item.id === summary.id ? summary : item))
      : [summary, ...this.items]
    this.writeIndex()
  }

  private readIndex(): AiConversationSummary[] {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as ConversationIndex
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) return []
      return parsed.items
        .filter((item) => VALID_ID.test(item.id))
        .map((item) => ({
          id: item.id,
          title: typeof item.title === 'string' ? item.title.slice(0, 200) : '新会话',
          modelProfileId: typeof item.modelProfileId === 'string' ? item.modelProfileId : '',
          mode: item.mode === 'assistant' || item.mode === 'agent' ? item.mode : 'chat',
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
          messageCount: typeof item.messageCount === 'number' ? item.messageCount : 0,
        }))
    } catch {
      return []
    }
  }

  private writeIndex(): void {
    const payload: ConversationIndex = { version: 1, items: this.items }
    this.atomicWrite(this.indexPath, JSON.stringify(payload, null, 2))
  }

  private writeConversation(conversation: AiConversation): void {
    this.atomicWrite(this.conversationPath(conversation.id), JSON.stringify(conversation, null, 2))
  }

  private atomicWrite(file: string, contents: string): void {
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  }

  private assertId(id: string): string {
    if (!VALID_ID.test(id)) throw new Error('非法会话 ID')
    return id
  }
}

/** Rebuild the index from on-disk conversation files (for tests/maintenance). */
export function rebuildConversationIndex(repo: AiConversationRepository, dataDir: string): number {
  const rootDir = path.join(dataDir, 'ai', 'conversations')
  if (!existsSync(rootDir)) return 0
  const files = readdirSync(rootDir).filter((f) => f.endsWith('.json') && f !== 'index.json')
  let count = 0
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(rootDir, file), 'utf8')) as RawConversation
      // Trigger migration + validation by going through get(); ignore failures.
      const id = typeof raw.id === 'string' ? raw.id : file.replace(/\.json$/, '')
      void repo.get(id)
      count++
    } catch {
      /* skip corrupt */
    }
  }
  return count
}
