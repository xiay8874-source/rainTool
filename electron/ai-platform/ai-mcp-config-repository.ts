// P4 MCP Server config repository — main-process, metadata-only persistence.
//
// Stores AiMcpServerConfig records under <userData>/ai/mcp-servers.json. This
// file holds METADATA ONLY: id, displayName, transport, source, trust,
// enabled, command/args fingerprint, status, tool count, timestamps. It NEVER
// persists tokens, env secrets, raw stderr, server instructions, tool raw
// payloads, or the confirmation nonce (the nonce is main-memory only in the
// manager). Writes are atomic with mode 0600.
//
// The renderer cannot write this file directly — it goes through the guarded
// IPC (add-stdio-candidate / confirm-activation / enable / disable / reconnect)
// which validates + sanitizes before persisting.

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  type AiMcpServerConfig,
  type AiMcpSource,
  type AiMcpStatus,
  type AiMcpTransport,
} from './ai-mcp-types.js'
import {
  FINGERPRINT_BUILT_IN,
  fingerprintLoopback,
  fingerprintStdio,
  isLoopbackUrl,
} from './ai-mcp-helpers.js'

const INDEX_VERSION = 1
const VALID_SERVER_ID = /^mcp_[A-Za-z0-9_-]{1,64}$/

interface IndexFile {
  version: number
  servers: AiMcpServerConfig[]
}

export interface AiMcpServerInput {
  displayName: string
  transport: AiMcpTransport
  source: AiMcpSource
  command?: string
  args?: string[]
  url?: string
  commandFingerprint: string
}

export class AiMcpConfigRepository {
  private readonly filePath: string
  private servers: Map<string, AiMcpServerConfig> = new Map()

  constructor(dataDir: string) {
    const dir = path.join(dataDir, 'ai')
    mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, 'mcp-servers.json')
    this.readIndex()
  }

  list(): AiMcpServerConfig[] {
    return [...this.servers.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): AiMcpServerConfig | null {
    if (!VALID_SERVER_ID.test(id)) return null
    return this.servers.get(id) ?? null
  }

  /** Add a new server config. The id is allocated by main (never renderer). */
  add(input: AiMcpServerInput): AiMcpServerConfig {
    const now = Date.now()
    const server: AiMcpServerConfig = {
      id: `mcp_${randomUUID()}`,
      displayName: sanitizeDisplayName(input.displayName),
      transport: input.transport,
      source: input.source,
      // User-stdio always starts disabled/pending; trusted built-in starts
      // disabled (enabled flips on explicit activation, same as user-stdio —
      // no auto-enable even for the built-in).
      enabled: false,
      createdAt: now,
      updatedAt: now,
      command: input.command,
      args: input.args,
      url: input.url,
      commandFingerprint: input.commandFingerprint,
      toolCount: 0,
      // User-stdio/user-loopback start pending-confirmation (both run code on
      // this machine); trusted built-in starts disabled (trusted but still
      // requires explicit activation — no auto-enable).
      status: input.source === 'trusted-built-in' ? 'disabled' : 'pending-confirmation',
    }
    this.servers.set(server.id, server)
    this.writeIndex()
    return server
  }

  /** Update mutable fields (status/toolCount/error/enabled). */
  update(id: string, patch: Partial<Pick<AiMcpServerConfig, 'status' | 'toolCount' | 'error' | 'enabled' | 'displayName'>>): AiMcpServerConfig | null {
    if (!VALID_SERVER_ID.test(id)) return null
    const existing = this.servers.get(id)
    if (!existing) return null
    const updated: AiMcpServerConfig = {
      ...existing,
      ...patch,
      id: existing.id, // immutable
      createdAt: existing.createdAt, // immutable
      transport: existing.transport, // immutable
      source: existing.source, // immutable
      commandFingerprint: existing.commandFingerprint, // immutable here
      updatedAt: Date.now(),
    }
    this.servers.set(id, updated)
    this.writeIndex()
    return updated
  }

  delete(id: string): boolean {
    if (!VALID_SERVER_ID.test(id)) return false
    if (!this.servers.delete(id)) return false
    this.writeIndex()
    return true
  }

  private readIndex(): void {
    if (!existsSync(this.filePath)) return
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8')) as IndexFile
      if (data.version !== INDEX_VERSION || !Array.isArray(data.servers)) return
      // Per-entry validation: a corrupt/tampered entry is dropped (never
      // crashes the app). Each entry must have the immutable shape; mutable
      // fields default safely. Args are validated (string array, bounded) so a
      // tampered index cannot smuggle a non-string arg past the eligibility that
      // ran at add time.
      const valid = new Map<string, AiMcpServerConfig>()
      for (const raw of data.servers) {
        const entry = validateServerEntry(raw)
        if (entry) valid.set(entry.id, entry)
      }
      this.servers = valid
    } catch {
      // Corrupt index — start empty rather than crashing. The file is metadata
      // only, so losing it is safe (servers must be re-added + re-confirmed).
    }
  }

  private writeIndex(): void {
    const data: IndexFile = { version: INDEX_VERSION, servers: this.list() }
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.filePath)
  }
}

function sanitizeDisplayName(name: string): string {
  const trimmed = String(name ?? '').trim().slice(0, 200)
  return trimmed || '未命名 MCP 服务器'
}

const VALID_TRANSPORT = new Set<AiMcpTransport>(['stdio', 'loopback-http'])
const VALID_SOURCE = new Set<AiMcpSource>(['trusted-built-in', 'user-stdio', 'user-loopback'])
const VALID_STATUS = new Set<AiMcpStatus>([
  'pending-confirmation', 'disabled', 'connecting', 'connected', 'error', 'disconnected',
])
const MAX_ARGS_LEN = 32
const MAX_ARG_LEN = 4096
const MAX_COMMAND_LEN = 1024
const MAX_URL_LEN = 2048
// 64-char lowercase hex (sha-256).
const FINGERPRINT_RE = /^[0-9a-f]{64}$/
// Absolute path: unix '/' or win32 'C:\' (drive letter). Rejects relative,
// '~', env vars, './', '../'.
const ABSOLUTE_COMMAND_RE = /^(?:\/|[A-Za-z]:[\\/])/
// Shell metacharacters forbidden in a stdio command (defense-in-depth; we
// spawn without shell, but a path triggering a shell is still rejected).
const STDIO_COMMAND_FORBIDDEN = /[;&|`$<>\n\r]/
// Shell-injection chars forbidden in stdio args. Plain spaces ARE allowed —
// args are passed directly to spawn (no shell), so spaces don't tokenize.
const STDIO_ARG_FORBIDDEN = /[;<>&|`$]/
const STDIO_ARG_CTRL = /[\n\r]/

/**
 * Validate a single server entry read from disk. A corrupt/tampered entry is
 * dropped (returns null) rather than crashing. Enforces the locked P4 per-source
 * contract:
 *
 *   - trusted-built-in (stdio only): NO command/args/url persisted; main
 *     resolves the launcher live. Fingerprint = sha256("trusted-built-in:raintool-mcp").
 *   - user-stdio (stdio only): absolute command, clean args (no shell/injection
 *     chars; plain spaces allowed). Fingerprint = sha256(command + "\0" + args.join("\0")).
 *   - user-loopback (loopback-http only): http URL, 127.0.0.1/::1/localhost,
 *     no credentials/query/hash, port present. Fingerprint = sha256(canonical URL).
 *
 * Source↔transport must agree. Args are validated (string array, bounded) so a
 * tampered index cannot smuggle a non-string arg or an unknown transport past
 * the eligibility that ran at add time.
 */
function validateServerEntry(raw: unknown): AiMcpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (typeof s.id !== 'string' || !VALID_SERVER_ID.test(s.id)) return null
  if (typeof s.displayName !== 'string') return null
  if (typeof s.transport !== 'string' || !VALID_TRANSPORT.has(s.transport as AiMcpTransport)) return null
  if (typeof s.source !== 'string' || !VALID_SOURCE.has(s.source as AiMcpSource)) return null
  const source = s.source as AiMcpSource
  const transport = s.transport as AiMcpTransport
  // Source↔transport agreement.
  if (source === 'trusted-built-in' && transport !== 'stdio') return null
  if (source === 'user-stdio' && transport !== 'stdio') return null
  if (source === 'user-loopback' && transport !== 'loopback-http') return null
  if (typeof s.enabled !== 'boolean') return null
  if (typeof s.createdAt !== 'number' || !Number.isFinite(s.createdAt) || s.createdAt < 0) return null
  if (typeof s.updatedAt !== 'number' || !Number.isFinite(s.updatedAt) || s.updatedAt < 0) return null
  if (typeof s.commandFingerprint !== 'string' || !FINGERPRINT_RE.test(s.commandFingerprint)) return null
  if (typeof s.toolCount !== 'number' || s.toolCount < 0 || !Number.isInteger(s.toolCount)) return null
  if (typeof s.status !== 'string' || !VALID_STATUS.has(s.status as AiMcpStatus)) return null
  // Optional fields with type + per-source checks.
  const command = typeof s.command === 'string' ? s.command.slice(0, MAX_COMMAND_LEN) : undefined
  const url = typeof s.url === 'string' ? s.url.slice(0, MAX_URL_LEN) : undefined
  const error = typeof s.error === 'string' ? s.error.slice(0, 300) : undefined
  // Args: must be a string array, bounded; reject non-string/oversize elements.
  let args: string[] | undefined
  if (Array.isArray(s.args)) {
    if (s.args.length > MAX_ARGS_LEN) return null
    const cleaned: string[] = []
    for (const a of s.args) {
      if (typeof a !== 'string' || a.length > MAX_ARG_LEN) return null
      cleaned.push(a)
    }
    args = cleaned
  }
  // Per-source field presence + content checks.
  if (source === 'trusted-built-in') {
    // Main resolves the launcher live; persisted command/args/url forbidden.
    if (command !== undefined || args !== undefined || url !== undefined) return null
  } else if (source === 'user-stdio') {
    // Absolute command, no shell metachars; url forbidden.
    if (typeof command !== 'string' || !command.trim()) return null
    if (!ABSOLUTE_COMMAND_RE.test(command)) return null
    if (STDIO_COMMAND_FORBIDDEN.test(command)) return null
    if (url !== undefined) return null
    // Args content: no shell-injection chars, no control chars (plain spaces OK).
    if (args) {
      for (const a of args) {
        if (STDIO_ARG_FORBIDDEN.test(a) || STDIO_ARG_CTRL.test(a)) return null
      }
    }
  } else {
    // user-loopback: URL required, command/args forbidden.
    if (typeof url !== 'string' || !url.trim()) return null
    if (command !== undefined || args !== undefined) return null
    if (!isLoopbackUrl(url)) return null
  }
  // Canonical-fingerprint verification (defense-in-depth): the persisted
  // commandFingerprint MUST match the canonical form for this source. A
  // tampered index cannot swap in an arbitrary fingerprint to bypass the
  // config-change invalidation in confirmActivation.
  const expected =
    source === 'trusted-built-in' ? FINGERPRINT_BUILT_IN()
    : source === 'user-stdio' ? fingerprintStdio(command!, args ?? [])
    : fingerprintLoopback(url!)
  if (s.commandFingerprint !== expected) return null
  return {
    id: s.id,
    displayName: sanitizeDisplayName(s.displayName),
    transport,
    source,
    enabled: s.enabled,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    command,
    args,
    url,
    commandFingerprint: s.commandFingerprint,
    toolCount: s.toolCount,
    status: s.status as AiMcpStatus,
    error,
  }
}

/** Re-export status type for callers that import from the repository. */
export type { AiMcpStatus } from './ai-mcp-types.js'
// Re-export shared helpers so callers importing from the repository get the
// same canonical fingerprint + loopback rules (single source of truth).
export { FINGERPRINT_BUILT_IN, fingerprintLoopback, fingerprintStdio, isLoopbackUrl } from './ai-mcp-helpers.js'
