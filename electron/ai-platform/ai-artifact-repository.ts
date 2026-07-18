// P2 Artifact Repository — main-process, read-only proposals.
//
// Stores Markdown / JSON / code artifacts produced by AI runs as PROPOSALS.
// The UI exposes only preview + copy — there is NO apply/writeback action.
// An artifact never alters editor text, a file, or a conversation directly.
//
// Persistence: one JSON file per artifact under <userData>/ai/artifacts/, plus
// an index.json. Each document holds the current content + a revision history
// (metadata only: revision number, timestamp, byte size). Writes are atomic
// with mode 0600. Restricted content (PEM / .env / AWS secrets) is REJECTED on
// create/update via classifySensitivity — no file is written. As defense-in-
// depth, redactSecrets still strips any residual secret markers from content
// before persistence. JSON artifacts are validated on create/update; invalid
// JSON is rejected with a safe error.

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
  type AiArtifactDocument,
  type AiArtifactInput,
  type AiArtifactJsonValidation,
  type AiArtifactKind,
  type AiArtifactMeta,
  type AiArtifactRevision,
} from './ai-context-types.js'
import { redactSecrets } from './ai-provider-registry.js'
import { utf8ByteLength } from './ai-context-budget.js'
import { classifySensitivity } from './ai-sensitivity-scanner.js'

const VALID_ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_ARTIFACT_CONTENT_BYTES = 256 * 1024
const MAX_REVISIONS = 50
const ARTIFACT_SCHEMA_VERSION = 1

interface IndexFile {
  version: number
  items: AiArtifactMeta[]
}

const INDEX_VERSION = 1

export class AiArtifactRepository {
  private readonly dir: string
  private readonly indexPath: string
  private items: AiArtifactMeta[]

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'ai', 'artifacts')
    mkdirSync(this.dir, { recursive: true })
    this.indexPath = path.join(this.dir, 'index.json')
    this.items = this.readIndex()
  }

  list(): AiArtifactMeta[] {
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): AiArtifactDocument | null {
    if (!VALID_ARTIFACT_ID.test(id)) return null
    const file = this.docPath(id)
    if (!existsSync(file)) return null
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as AiArtifactDocument
      return doc
    } catch {
      return null
    }
  }

  /** Create a new artifact. Restricted content is rejected; JSON validated first. */
  create(input: AiArtifactInput): AiArtifactDocument {
    this.assertContent(input.content)
    this.assertNotRestricted(input.content)
    if (input.kind === 'json') {
      const v = validateJson(input.content)
      if (!v.valid) throw new Error(`JSON 校验失败：${v.error}`)
    }
    const id = `art_${randomUUID()}`
    const now = Date.now()
    const content = sanitizeContent(input.content)
    const revision: AiArtifactRevision = { revision: 1, at: now, byteSize: utf8ByteLength(content) }
    const doc: AiArtifactDocument = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      id,
      kind: input.kind,
      title: sanitizeTitle(input.title),
      content,
      language: input.language,
      conversationId: input.conversationId,
      runId: input.runId,
      createdAt: now,
      updatedAt: now,
      revisionCount: 1,
      revisions: [revision],
    }
    this.writeDoc(doc)
    this.items = [toMeta(doc), ...this.items]
    this.writeIndex()
    return doc
  }

  /**
   * Update an artifact's content (creates a new revision). Restricted content
   * is rejected; JSON artifacts are validated. This is the ONLY mutation path —
   * there is no apply/writeback.
   */
  update(id: string, content: string): AiArtifactDocument {
    if (!VALID_ARTIFACT_ID.test(id)) throw new Error('无效的 artifact ID')
    const doc = this.get(id)
    if (!doc) throw new Error('artifact 不存在')
    this.assertContent(content)
    this.assertNotRestricted(content)
    if (doc.kind === 'json') {
      const v = validateJson(content)
      if (!v.valid) throw new Error(`JSON 校验失败：${v.error}`)
    }
    const sanitized = sanitizeContent(content)
    const now = Date.now()
    const revision: AiArtifactRevision = {
      revision: doc.revisionCount + 1,
      at: now,
      byteSize: utf8ByteLength(sanitized),
    }
    const updated: AiArtifactDocument = {
      ...doc,
      content: sanitized,
      updatedAt: now,
      revisionCount: revision.revision,
      revisions: [revision, ...doc.revisions].slice(0, MAX_REVISIONS),
    }
    this.writeDoc(updated)
    this.items = [toMeta(updated), ...this.items.filter((m) => m.id !== id)]
    this.writeIndex()
    return updated
  }

  delete(id: string): boolean {
    if (!VALID_ARTIFACT_ID.test(id)) return false
    const file = this.docPath(id)
    if (!existsSync(file)) return false
    try { unlinkSync(file) } catch { /* ignore */ }
    this.items = this.items.filter((m) => m.id !== id)
    this.writeIndex()
    return true
  }

  /** Validate JSON content without creating an artifact (for the UI). */
  validateJson(content: string): AiArtifactJsonValidation {
    return validateJson(content)
  }

  private docPath(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }

  private assertContent(content: string): void {
    if (utf8ByteLength(content) > MAX_ARTIFACT_CONTENT_BYTES) {
      throw new Error('artifact 内容过大')
    }
  }

  /**
   * Reject restricted content (PEM / .env / AWS secrets) BEFORE any file is
   * written. The error message carries only the safe reason label — never the
   * matched secret. redactSecrets remains as defense-in-depth for any content
   * that slips past classification, but restricted content never reaches disk.
   */
  private assertNotRestricted(content: string): void {
    const result = classifySensitivity(content)
    if (result.sensitivity === 'restricted') {
      throw new Error(`artifact 内容含受限内容（${result.reason}），已拒绝`)
    }
  }

  private writeDoc(doc: AiArtifactDocument): void {
    const file = this.docPath(doc.id)
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  }

  private readIndex(): AiArtifactMeta[] {
    if (!existsSync(this.indexPath)) return []
    try {
      const data = JSON.parse(readFileSync(this.indexPath, 'utf8')) as IndexFile
      if (data.version !== INDEX_VERSION) return []
      return Array.isArray(data.items) ? data.items : []
    } catch {
      return []
    }
  }

  private writeIndex(): void {
    const data: IndexFile = { version: INDEX_VERSION, items: this.items }
    const temp = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.indexPath)
  }
}

/** Validate that content parses as JSON. Returns a safe error (no raw content). */
export function validateJson(content: string): AiArtifactJsonValidation {
  const trimmed = content.trim()
  if (trimmed.length === 0) return { valid: false, error: '内容为空' }
  try {
    JSON.parse(trimmed)
    return { valid: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { valid: false, error: redactSecrets(msg).slice(0, 200) }
  }
}

/** Classify an artifact kind from content heuristics (for auto-kind on create). */
export function classifyArtifactKind(content: string): AiArtifactKind {
  const trimmed = content.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  if (/^#{1,6}\s|^\*\s|^-\s/m.test(trimmed)) return 'markdown'
  return 'code'
}

function toMeta(doc: AiArtifactDocument): AiArtifactMeta {
  return {
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    language: doc.language,
    conversationId: doc.conversationId,
    runId: doc.runId,
    revisionCount: doc.revisionCount,
  }
}

function sanitizeTitle(title: string): string {
  const trimmed = title.trim().slice(0, 200)
  return trimmed || '未命名 artifact'
}

/** Strip secrets from artifact content before persisting (defense-in-depth). */
function sanitizeContent(content: string): string {
  return redactSecrets(content)
}
