import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type {
  DiagramCreateInput,
  DiagramDocument,
  DiagramDuplicateInput,
  DiagramListQuery,
  DiagramListResult,
  DiagramMetadata,
  DiagramRevisionMetadata,
  DiagramSource,
  DiagramUpdateInput,
  LegacyDiagramInput,
  LegacyDiagramMigrationResult,
} from './diagram-types.js'

const INDEX_VERSION = 1
const MAX_XML_BYTES = 12 * 1024 * 1024
const MAX_REVISIONS = 20
const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/
const SOURCES = new Set<DiagramSource>(['raintool', 'zcode', 'codex', 'mcp', 'legacy'])

interface DiagramIndex {
  version: number
  items: DiagramMetadata[]
}

export class DiagramConflictError extends Error {
  readonly current: DiagramDocument

  constructor(current: DiagramDocument) {
    super(`图纸版本冲突：期望版本已过期，当前版本为 ${current.revision}`)
    this.name = 'DiagramConflictError'
    this.current = current
  }
}

export class DiagramNotFoundError extends Error {
  constructor(id: string) {
    super(`图纸不存在：${id}`)
    this.name = 'DiagramNotFoundError'
  }
}

function sanitizeTitle(title: string | undefined, fallback = '未命名图纸'): string {
  const normalized = title?.trim().replace(/[\u0000-\u001f]/g, '')
  return (normalized || fallback).slice(0, 200)
}

function sanitizeTags(tags: string[] | undefined): string[] {
  if (!tags) return []
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)))
    .slice(0, 20)
    .map((tag) => tag.slice(0, 50))
}

function sanitizeSource(source: DiagramSource | undefined): DiagramSource {
  return source && SOURCES.has(source) ? source : 'raintool'
}

function assertXml(xml: string): void {
  if (!xml.trim()) throw new Error('图纸 XML 不能为空')
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    throw new Error(`图纸 XML 超过 ${MAX_XML_BYTES / 1024 / 1024} MB 限制`)
  }
}

function defaultDiagramXml(id: string): string {
  return `<mxfile host="RainTool"><diagram id="${id}" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`
}

export class DiagramRepository {
  readonly rootDir: string
  private readonly indexPath: string
  private items: DiagramMetadata[]

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, 'diagrams')
    this.indexPath = path.join(this.rootDir, 'index.json')
    mkdirSync(this.rootDir, { recursive: true })
    this.items = this.readIndex()
  }

  list(query: DiagramListQuery = {}): DiagramListResult {
    const search = query.query?.trim().toLocaleLowerCase() ?? ''
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 100)))
    const filtered = this.items
      .filter((item) => query.favorite === undefined || item.favorite === query.favorite)
      .filter((item) => !query.source || item.source === query.source)
      .filter((item) => {
        if (!search) return true
        return (
          item.title.toLocaleLowerCase().includes(search) ||
          item.tags.some((tag) => tag.toLocaleLowerCase().includes(search)) ||
          item.sourceClient?.toLocaleLowerCase().includes(search)
        )
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      items: filtered.slice(offset, offset + limit).map((item) => ({ ...item, tags: [...item.tags] })),
      total: filtered.length,
    }
  }

  get(id: string): DiagramDocument | null {
    this.assertId(id)
    const metadata = this.items.find((item) => item.id === id)
    if (!metadata) return null
    try {
      return {
        ...metadata,
        tags: [...metadata.tags],
        xml: readFileSync(this.documentPath(id), 'utf8'),
      }
    } catch {
      return null
    }
  }

  require(id: string): DiagramDocument {
    const document = this.get(id)
    if (!document) throw new DiagramNotFoundError(id)
    return document
  }

  create(input: DiagramCreateInput = {}): DiagramDocument {
    const id = randomUUID()
    const now = Date.now()
    const xml = input.xml ?? defaultDiagramXml(id)
    assertXml(xml)
    const metadata: DiagramMetadata = {
      id,
      title: sanitizeTitle(input.title),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      source: sanitizeSource(input.source),
      sourceClient: input.sourceClient?.trim().slice(0, 100) || undefined,
      favorite: input.favorite ?? false,
      tags: sanitizeTags(input.tags),
      legacySessionId: input.legacySessionId?.trim().slice(0, 128) || undefined,
    }
    mkdirSync(this.documentDir(id), { recursive: true })
    this.atomicWrite(this.documentPath(id), xml)
    this.items.unshift(metadata)
    this.writeIndex()
    return { ...metadata, tags: [...metadata.tags], xml }
  }

  update(input: DiagramUpdateInput): DiagramDocument {
    const current = this.require(input.id)
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      throw new DiagramConflictError(current)
    }
    const xml = input.xml ?? current.xml
    assertXml(xml)
    const xmlChanged = input.xml !== undefined && input.xml !== current.xml
    if (xmlChanged) this.saveRevision(current)

    const next: DiagramMetadata = {
      ...current,
      title: input.title === undefined ? current.title : sanitizeTitle(input.title, current.title),
      favorite: input.favorite ?? current.favorite,
      tags: input.tags === undefined ? current.tags : sanitizeTags(input.tags),
      revision: current.revision + 1,
      updatedAt: Date.now(),
    }
    if (xmlChanged) this.atomicWrite(this.documentPath(current.id), xml)
    this.items = this.items.map((item) => (item.id === current.id ? next : item))
    this.writeIndex()
    return { ...next, tags: [...next.tags], xml }
  }

  duplicate(input: DiagramDuplicateInput): DiagramDocument {
    const source = this.require(input.id)
    return this.create({
      title: sanitizeTitle(input.title, `${source.title} 副本`),
      xml: source.xml,
      source: sanitizeSource(input.source ?? source.source),
      sourceClient: input.sourceClient ?? source.sourceClient,
      tags: source.tags,
    })
  }

  delete(id: string): boolean {
    this.assertId(id)
    if (!this.items.some((item) => item.id === id)) return false
    this.removeDocumentFiles(id)
    this.items = this.items.filter((item) => item.id !== id)
    this.writeIndex()
    return true
  }

  listRevisions(id: string): DiagramRevisionMetadata[] {
    this.require(id)
    const revisionsDir = this.revisionsDir(id)
    if (!existsSync(revisionsDir)) return []
    return readdirSync(revisionsDir)
      .filter((name) => /^\d+\.drawio$/.test(name))
      .map((name) => {
        const file = path.join(revisionsDir, name)
        return {
          revision: Number.parseInt(name, 10),
          savedAt: statSync(file).mtimeMs,
        }
      })
      .sort((a, b) => b.revision - a.revision)
  }

  restoreRevision(id: string, revision: number, expectedRevision?: number): DiagramDocument {
    const file = path.join(this.revisionsDir(id), `${revision}.drawio`)
    if (!existsSync(file)) throw new Error(`图纸版本不存在：${revision}`)
    return this.update({
      id,
      xml: readFileSync(file, 'utf8'),
      expectedRevision,
    })
  }

  migrateLegacy(inputs: LegacyDiagramInput[]): LegacyDiagramMigrationResult {
    const documents: DiagramDocument[] = []
    let skipped = 0
    for (const input of inputs.slice(0, 200)) {
      const legacySessionId = input.legacySessionId?.trim()
      if (!legacySessionId || !input.xml?.trim()) {
        skipped++
        continue
      }
      const existing = this.items.find((item) => item.legacySessionId === legacySessionId)
      if (existing) {
        skipped++
        continue
      }
      const document = this.create({
        title: input.title,
        xml: input.xml,
        source: 'legacy',
        sourceClient: 'next-ai-draw-io IndexedDB',
        legacySessionId,
      })
      const metadata = this.items.find((item) => item.id === document.id)
      if (metadata) {
        metadata.createdAt = input.createdAt ?? metadata.createdAt
        metadata.updatedAt = input.updatedAt ?? metadata.updatedAt
        this.writeIndex()
        documents.push(this.require(metadata.id))
      }
    }
    return { imported: documents.length, skipped, documents }
  }

  private readIndex(): DiagramMetadata[] {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as DiagramIndex
      if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.items)) return []
      return parsed.items.filter((item) => VALID_ID.test(item.id)).map((item) => ({
        ...item,
        title: sanitizeTitle(item.title),
        source: sanitizeSource(item.source),
        favorite: Boolean(item.favorite),
        tags: sanitizeTags(item.tags),
      }))
    } catch {
      return []
    }
  }

  private writeIndex(): void {
    this.atomicWrite(this.indexPath, JSON.stringify({ version: INDEX_VERSION, items: this.items }, null, 2))
  }

  private saveRevision(document: DiagramDocument): void {
    const revisionsDir = this.revisionsDir(document.id)
    mkdirSync(revisionsDir, { recursive: true })
    const revisionPath = path.join(revisionsDir, `${document.revision}.drawio`)
    if (!existsSync(revisionPath)) this.atomicWrite(revisionPath, document.xml)
    const revisions = this.listRevisions(document.id)
    for (const old of revisions.slice(MAX_REVISIONS)) {
      try { unlinkSync(path.join(revisionsDir, `${old.revision}.drawio`)) } catch { /* ignore */ }
    }
  }

  private removeDocumentFiles(id: string): void {
    const revisionsDir = this.revisionsDir(id)
    if (existsSync(revisionsDir)) {
      for (const name of readdirSync(revisionsDir)) {
        try { unlinkSync(path.join(revisionsDir, name)) } catch { /* ignore */ }
      }
    }
    try { unlinkSync(this.documentPath(id)) } catch { /* ignore */ }
    try { unlinkSync(path.join(this.documentDir(id), '.keep')) } catch { /* ignore */ }
    try { requireDirectoryRemoval(revisionsDir) } catch { /* ignore */ }
    try { requireDirectoryRemoval(this.documentDir(id)) } catch { /* ignore */ }
  }

  private documentDir(id: string): string {
    this.assertId(id)
    return path.join(this.rootDir, id)
  }

  private documentPath(id: string): string {
    return path.join(this.documentDir(id), 'diagram.drawio')
  }

  private revisionsDir(id: string): string {
    return path.join(this.documentDir(id), 'revisions')
  }

  private assertId(id: string): void {
    if (!VALID_ID.test(id)) throw new Error('非法图纸 ID')
  }

  private atomicWrite(file: string, contents: string): void {
    mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  }
}

function requireDirectoryRemoval(directory: string): void {
  if (!existsSync(directory)) return
  const entries = readdirSync(directory)
  if (entries.length > 0) throw new Error(`目录非空：${directory}`)
  rmdirSync(directory)
}
