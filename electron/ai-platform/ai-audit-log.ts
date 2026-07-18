// P3 Audit Log — main-process, append-only, capped, safe-metadata-only.
//
// Every tool/approval/run event is recorded here. The log is the forensic
// record: proposed, approved/rejected/expired/cancelled, started,
// completed/failed, run terminal. EVERY text field is sanitized via
// sanitizeToolText (redactSecrets + classifySensitivity) before append — no
// raw attachments, API keys, tool payloads, or restricted content ever land
// in the log. The audit summary is a FIXED metadata label (tool/risk/scope/
// count/length) — NEVER the raw tool input/payload (Blocker 3).
//
// Persistence: <userData>/ai/audit.jsonl, one JSON object per line, atomic
// append (fs.appendFileSync with mode 0600). Capped at AI_AUDIT_MAX_ENTRIES
// via FIFO rotation. The renderer may ONLY read (list IPC); there is no
// renderer clear/append — the log is append-only from the main process and
// read-only from the renderer. There is NO public clear() at all (Blocker 3):
// the log is never wiped by the renderer. Internal rotation drops the oldest
// entries when over cap; that is the only deletion path.
//
// Rotation correctness: on append, if the in-memory buffer would exceed the
// cap, we drop the oldest entries and REWRITE the whole file (so the new
// entry appears exactly once). On the normal path (under cap), we append a
// single line. The new entry is NEVER both rewritten and appended.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  AI_AUDIT_MAX_ENTRIES,
  type AiAuditEntry,
  type AiAuditFilter,
  type AiAuditKind,
} from './ai-tool-types.js'
import { sanitizeToolText } from './ai-tool-registry.js'

export class AiAuditLog {
  private readonly filePath: string
  private entries: AiAuditEntry[] = []

  constructor(dataDir: string) {
    const dir = path.join(dataDir, 'ai')
    mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, 'audit.jsonl')
    this.entries = this.readAll()
  }

  /**
   * Append a sanitized entry. Safe to call with raw text — it is redacted.
   * The new entry appears in the file EXACTLY once: either as a single
   * appended line (under cap) or as part of a full rewrite (at/over cap).
   */
  append(entry: AiAuditEntry): void {
    const safe: AiAuditEntry = {
      at: entry.at,
      runId: entry.runId,
      kind: entry.kind,
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      ...(entry.toolId ? { toolId: entry.toolId } : {}),
      ...(entry.risk ? { risk: entry.risk } : {}),
      ...(entry.summary ? { summary: sanitizeToolText(entry.summary, 200) } : {}),
      ...(entry.redactedError ? { redactedError: sanitizeToolText(entry.redactedError, 300) } : {}),
      ...(entry.category ? { category: entry.category } : {}),
    }
    this.entries.push(safe)
    if (this.entries.length > AI_AUDIT_MAX_ENTRIES) {
      // Over cap: drop oldest, rewrite the WHOLE file (new entry included
      // exactly once). Do NOT also appendLine — that would duplicate it.
      const drop = this.entries.length - AI_AUDIT_MAX_ENTRIES
      this.entries = this.entries.slice(drop)
      this.rewriteFile()
    } else {
      // Under cap: append just the new line.
      this.appendLine(safe)
    }
  }

  /** Read-only list (newest first). Filtered + capped by the caller's limit. */
  list(filter?: AiAuditFilter): AiAuditEntry[] {
    let result = [...this.entries]
    if (filter?.runId) result = result.filter((e) => e.runId === filter.runId)
    if (filter?.toolId) result = result.filter((e) => e.toolId === filter.toolId)
    if (filter?.kind) result = result.filter((e) => e.kind === filter.kind)
    result.reverse() // newest first
    const limit = filter?.limit ?? 200
    return result.slice(0, limit)
  }

  /** Convenience: record a tool/approval/run event in one call. */
  record(
    runId: string,
    kind: AiAuditKind,
    extra?: Partial<AiAuditEntry>,
  ): void {
    this.append({
      at: Date.now(),
      runId,
      kind,
      ...extra,
    })
  }

  /** Rewrite the entire file from the in-memory entries (rotation path). */
  private rewriteFile(): void {
    const temp = `${this.filePath}.${process.pid}.tmp`
    const lines = this.entries.map((e) => JSON.stringify(e)).join('\n')
    writeFileSync(temp, lines + (lines ? '\n' : ''), { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(temp, this.filePath)
    } catch {
      writeFileSync(this.filePath, lines + (lines ? '\n' : ''), { encoding: 'utf8', mode: 0o600 })
    }
  }

  private appendLine(entry: AiAuditEntry): void {
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  private readAll(): AiAuditEntry[] {
    if (!existsSync(this.filePath)) return []
    try {
      const text = readFileSync(this.filePath, 'utf8')
      const entries: AiAuditEntry[] = []
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          entries.push(JSON.parse(trimmed) as AiAuditEntry)
        } catch {
          // Skip a corrupt line rather than crashing.
        }
      }
      return entries
    } catch {
      return []
    }
  }
}
