// P2 Context Vault — main-process in-memory attachment payload store.
//
// Stores raw attachment text ONLY in memory for the active run/session. The
// raw payload is sent ONCE from the trusted renderer to the main process via
// the `ai:context:ingest` IPC handler; after that it is NEVER returned to the
// renderer, NEVER logged, and NEVER persisted to disk (only metadata-only
// placeholders survive a restart, and they carry no payload). Only
// AiAttachmentMeta (id, title, size, tokens, sensitivity, storage policy,
// expiry, payloadAvailable) is returned to the renderer.
//
// Lifecycle: payloads expire (TTL), and are cleared on cancel/delete/quit. The
// vault exposes `clearAll` (quit), `clearForRun` (cancel), and `purgeExpired`
// (lazy + sweep). A `metadata-only` storage policy persists the meta index to
// disk so chips survive a reload as placeholders (payloadAvailable: false; the
// payload is still in-memory-only and cleared the same way); an `ephemeral`
// policy persists nothing.
//
// Hard rules:
//   1. `getText` is main-process only (the runtime calls it to assemble context
//      for the provider call). The renderer never receives payload text.
//   2. Restricted payloads are stored (so the UI chip can show the restriction)
//      but are NEVER handed to the budget gate as sendable text — the gate
//      marks them rejected-restricted and blocks the run fail-closed.
//   3. No payload text appears in any error, log, or persisted file.

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
import {
  AI_CONTEXT_DEFAULT_TTL_MS,
  type AiAttachmentInput,
  type AiAttachmentMeta,
  type AiAttachmentStorage,
} from './ai-context-types.js'
import { classifySensitivity } from './ai-sensitivity-scanner.js'
import { estimateTokens, utf8ByteLength } from './ai-context-budget.js'

const VALID_ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

interface VaultEntry {
  meta: AiAttachmentMeta
  text: string
}

interface MetaIndex {
  version: number
  /** Only metadata-only attachments are persisted (as placeholders). */
  metas: AiAttachmentMeta[]
}

const META_INDEX_VERSION = 1

/**
 * In-memory context vault. Constructor takes the data dir for the metadata-only
 * index path; the raw payloads are never written there.
 */
export class AiContextVault {
  private readonly entries = new Map<string, VaultEntry>()
  private readonly metaIndexPath: string
  private persistedMetas: AiAttachmentMeta[] = []

  constructor(dataDir: string) {
    const aiDir = path.join(dataDir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    this.metaIndexPath = path.join(aiDir, 'context-metas.json')
    this.persistedMetas = this.readMetaIndex()
  }

  /** Ingest an attachment; returns its metadata. Payload stays in memory. */
  ingest(input: AiAttachmentInput, ttlMs: number = AI_CONTEXT_DEFAULT_TTL_MS): AiAttachmentMeta {
    const id = `ctx_${randomUUID()}`
    const byteSize = utf8ByteLength(input.text)
    const tokenEstimate = estimateTokens(input.text)
    const sensitivity = classifySensitivity(input.text)
    const now = Date.now()
    const meta: AiAttachmentMeta = {
      id,
      source: input.source,
      title: sanitizeTitle(input.title),
      byteSize,
      tokenEstimate,
      sensitivity: sensitivity.sensitivity,
      storage: input.storage ?? 'ephemeral',
      createdAt: now,
      expiresAt: now + ttlMs,
      restrictionReason: sensitivity.reason,
      payloadAvailable: true,
    }
    this.entries.set(id, { meta, text: input.text })
    if (meta.storage === 'metadata-only') {
      this.persistedMetas = [meta, ...this.persistedMetas.filter((m) => m.id !== id)]
      this.writeMetaIndex()
    }
    return meta
  }

  /**
   * List attachment metas (renderer view; no payload). Includes both in-memory
   * entries (payloadAvailable: true) and persisted placeholders loaded after a
   * restart (payloadAvailable: false — the ephemeral payload is gone). The
   * renderer shows placeholders as unavailable chips.
   */
  list(): AiAttachmentMeta[] {
    this.purgeExpired()
    const seen = new Set<string>()
    const result: AiAttachmentMeta[] = []
    // In-memory entries first (payload available).
    for (const entry of this.entries.values()) {
      if (Date.now() < entry.meta.expiresAt) {
        result.push({ ...entry.meta, payloadAvailable: true })
        seen.add(entry.meta.id)
      }
    }
    // Then persisted placeholders not already in memory (payload unavailable).
    for (const m of this.persistedMetas) {
      if (!seen.has(m.id)) {
        result.push({ ...m, payloadAvailable: false })
      }
    }
    return result
  }

  /**
   * Get metadata by id for the RENDERER (returns null if unknown/expired). This
   * returns the meta even for a placeholder (payloadAvailable reflects reality).
   * Use `getMetaForSend` / `getText` to check payload availability before
   * sending to the provider.
   */
  getMeta(id: string): AiAttachmentMeta | null {
    if (!VALID_ATTACHMENT_ID.test(id)) return null
    const entry = this.entries.get(id)
    if (entry) {
      if (Date.now() >= entry.meta.expiresAt) {
        this.entries.delete(id)
        // Fall through to check persisted placeholder.
      } else {
        return { ...entry.meta, payloadAvailable: true }
      }
    }
    // Check persisted placeholder.
    const persisted = this.persistedMetas.find((m) => m.id === id)
    if (persisted) return { ...persisted, payloadAvailable: false }
    return null
  }

  /**
   * Get metadata by id ONLY if the payload is available in memory (sendable).
   * Returns null for placeholders, unknown, or expired ids. The runtime uses
   * this to decide which attachments actually become model context.
   */
  getMetaForSend(id: string): AiAttachmentMeta | null {
    if (!VALID_ATTACHMENT_ID.test(id)) return null
    const entry = this.entries.get(id)
    if (!entry) return null
    if (Date.now() >= entry.meta.expiresAt) {
      this.entries.delete(id)
      return null
    }
    return { ...entry.meta, payloadAvailable: true }
  }

  /**
   * Get the raw payload text (MAIN-PROCESS ONLY — runtime assembles context).
   * Returns null for unknown/expired/placeholder ids. A metadata-only
   * placeholder loaded after a restart has NO payload and is rejected here.
   * Restricted payloads ARE returned here; the budget gate (not the vault)
   * decides whether they are sent.
   */
  getText(id: string): string | null {
    if (!VALID_ATTACHMENT_ID.test(id)) return null
    const entry = this.entries.get(id)
    if (!entry) return null // placeholder or unknown — no payload
    if (Date.now() >= entry.meta.expiresAt) {
      this.entries.delete(id)
      return null
    }
    return entry.text
  }

  /** Delete a single attachment (removes in-memory payload + persisted meta). */
  delete(id: string): boolean {
    if (!VALID_ATTACHMENT_ID.test(id)) return false
    const memExisted = this.entries.delete(id)
    const persistedBefore = this.persistedMetas.length
    this.persistedMetas = this.persistedMetas.filter((m) => m.id !== id)
    const persistedExisted = this.persistedMetas.length !== persistedBefore
    if (persistedExisted) this.writeMetaIndex()
    return memExisted || persistedExisted
  }

  /** Clear payloads for a specific run's attachments (cancel path). */
  clearForRun(ids: string[]): void {
    for (const id of ids) {
      if (VALID_ATTACHMENT_ID.test(id)) this.entries.delete(id)
    }
  }

  /** Clear ALL in-memory payloads (quit path). Persisted metas are kept as
   *  placeholders; their payloads are gone. */
  clearAll(): void {
    this.entries.clear()
  }

  /** Remove expired payloads (lazy purge). */
  purgeExpired(): number {
    const now = Date.now()
    let purged = 0
    for (const [id, entry] of this.entries) {
      if (now >= entry.meta.expiresAt) {
        this.entries.delete(id)
        purged++
      }
    }
    return purged
  }

  /**
   * Validate that all ids are known, non-expired, AND have an available payload
   * (IPC boundary). Rejects placeholders without payload, unknown ids, and
   * invalid id formats. This is the gate the IPC `ai:run:start` handler uses
   * before allocating a run — a placeholder chip cannot start a run.
   */
  validateIds(ids: string[]): { ok: true; metas: AiAttachmentMeta[] } | { ok: false; reason: string; unknownIds: string[] } {
    const metas: AiAttachmentMeta[] = []
    const unknownIds: string[] = []
    for (const id of ids) {
      if (!VALID_ATTACHMENT_ID.test(id)) {
        return { ok: false, reason: `无效的附件 ID：${redactId(id)}`, unknownIds: [id] }
      }
      // Must have an in-memory payload to be sendable.
      const meta = this.getMetaForSend(id)
      if (!meta) {
        // Distinguish placeholder (persisted meta but no payload) from truly unknown.
        const placeholder = this.persistedMetas.find((m) => m.id === id)
        if (placeholder) {
          return { ok: false, reason: `附件 ${redactId(id)} 的内容已失效（重启后不可用），请重新附加`, unknownIds: [id] }
        }
        unknownIds.push(id)
        continue
      }
      metas.push(meta)
    }
    if (unknownIds.length > 0) {
      return { ok: false, reason: `未知的附件 ID（${unknownIds.length} 个）`, unknownIds }
    }
    return { ok: true, metas }
  }

  private readMetaIndex(): AiAttachmentMeta[] {
    if (!existsSync(this.metaIndexPath)) return []
    try {
      const raw = readFileSync(this.metaIndexPath, 'utf8')
      const data = JSON.parse(raw) as MetaIndex
      if (data.version !== META_INDEX_VERSION) return []
      return Array.isArray(data.metas) ? data.metas : []
    } catch {
      return []
    }
  }

  private writeMetaIndex(): void {
    const data: MetaIndex = { version: META_INDEX_VERSION, metas: this.persistedMetas }
    const temp = `${this.metaIndexPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.metaIndexPath)
  }
}

function sanitizeTitle(title: string): string {
  const trimmed = title.trim().slice(0, 120)
  return trimmed || '未命名附件'
}

/** Redact an id fragment for error messages (never echo the raw input verbatim). */
function redactId(id: string): string {
  if (id.length <= 8) return '••••'
  return `${id.slice(0, 4)}••••`
}
