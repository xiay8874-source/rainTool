// P4 MCP Client Manager — main-process only.
//
// Owns the MCP client lifecycle: eligibility validation, main-owned single-use
// TTL confirmation (config-change invalidating), spawn-without-shell + sanitized
// minimal env + bounded lengths/timeouts, SDK v1 connect + listTools, untrusted-
// data handling, inventory-only generic tools, the RainTool built-in trusted
// path, and lifecycle (connect/disconnect/reconnect/failed-cleanup/idempotency).
//
// SECURITY MODEL (plan §6.3 / §P4, docs/ai-platform-p4.md):
//   - The renderer NEVER spawns/connects MCP. It sends validated config
//     candidates + confirmation nonces; main owns every connection.
//   - Eligibility rejects: remote/non-loopback hosts, OAuth, sampling,
//     elicitation, shell mode, inherited arbitrary env, stdin injection.
//   - User-stdio is stored disabled/pending until a dedicated renderer
//     confirmation shows the exact command/args/source/risk. The confirmation
//     nonce is main-owned, single-use, short-TTL, and bound to the
//     commandFingerprint — a config change invalidates it. The renderer cannot
//     forge activation (no matching nonce+fingerprint → reject).
//   - The bundled RainTool MCP is a trusted built-in; its actual packaged/dev
//     launcher path is selected ONLY by main (never a renderer path).
//   - On connect, server names/descriptions/schemas/instructions are UNTRUSTED
//     data: they MUST NOT alter the system prompt, risk levels, approvals,
//     allowed roots, command policy, or modes. Instructions are never rendered
//     as privileged text. Generic discovered external tools are inventory-only
//     (NOT executable in P4) unless a future phase adds an explicit main-process
//     policy adapter.
//   - No token/env-secret/raw-stderr/instruction/tool-payload crosses to the
//     renderer or the persisted config. Errors are short, factual, actionable,
//     redacted.
//
// P4 does NOT implement: model tool-calling, an Agent loop, executable MCP
// tools, remote/HTTP(non-loopback)/OAuth/sampling/elicitation transports.

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { redactSecrets } from './ai-provider-registry.js'
import { classifySensitivity } from './ai-sensitivity-scanner.js'
import {
  FINGERPRINT_BUILT_IN,
  fingerprintLoopback,
  fingerprintStdio,
  isLoopbackUrl,
  sha256Hex,
  BoundedStderrSink,
} from './ai-mcp-helpers.js'
import {
  AI_MCP_CALL_TIMEOUT_MS,
  AI_MCP_CONFIRMATION_TTL_MS,
  AI_MCP_CONNECT_TIMEOUT_MS,
  AI_MCP_MAX_ARG_LEN,
  AI_MCP_MAX_ARGS,
  AI_MCP_MAX_COMMAND_LEN,
  AI_MCP_MAX_STDIO_CAPTURE_BYTES,
  AI_MCP_MAX_TOOLS_PER_SERVER,
  type AiMcpConfirmationRequest,
  type AiMcpServerConfig,
  type AiMcpServerEvent,
  type AiMcpSource,
  type AiMcpToolMeta,
  type AiMcpTransport,
} from './ai-mcp-types.js'
import type { AiMcpConfigRepository, AiMcpServerInput } from './ai-mcp-config-repository.js'

/** Result of an eligibility check on a candidate config. */
export type AiMcpEligibility =
  | { ok: true }
  | { ok: false; reason: string }

/** A main-owned pending confirmation entry (memory only, never persisted). */
interface PendingConfirmation {
  serverId: string
  nonce: string
  commandFingerprint: string
  expiresAt: number
  used: boolean
}

/** An active MCP client connection (memory only). */
interface ActiveConnection {
  serverId: string
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport
  /** Discovered tools (untrusted metadata, inventory-only). */
  tools: AiMcpToolMeta[]
  /**
   * Bounded stderr capture sink (tail only, byte-capped, main-internal). Raw
   * stderr NEVER crosses to config/event/renderer — the connect() catch
   * composes `reason = sanitizeError(error)` only. The sink exists for future
   * main-side diagnostics; the outward error never includes it.
   */
  stderrBuf: BoundedStderrSink
  /** Whether close() has been invoked (idempotency). */
  closing: boolean
}

export interface AiMcpManagerDeps {
  configRepository: AiMcpConfigRepository
  /** Resolve the bundled RainTool MCP launcher path (packaged vs dev). */
  resolveBundledLauncher: () => { command: string; args: string[] } | null
  /** Emit a status-change event to the renderer. */
  emit: (event: AiMcpServerEvent) => void
}

export class AiMcpManager {
  private readonly deps: AiMcpManagerDeps
  private readonly emit: (event: AiMcpServerEvent) => void
  private readonly pending = new Map<string, PendingConfirmation>()
  private readonly active = new Map<string, ActiveConnection>()
  /**
   * In-flight connection guards (serverId → true). Prevents two concurrent
   * enable()/reconnect() calls from each passing the `active.has` check and
   * spawning two transports for the same server (race → duplicate process).
   */
  private readonly connecting = new Set<string>()

  constructor(deps: AiMcpManagerDeps) {
    this.deps = deps
    this.emit = deps.emit
    // Purge expired confirmations periodically so nonces don't leak.
    setInterval(() => this.purgeExpiredConfirmations(), 30_000).unref?.()
  }

  // -------------------------------------------------------------------------
  // Listing + status
  // -------------------------------------------------------------------------

  listServers(): AiMcpServerConfig[] {
    return this.deps.configRepository.list()
  }

  listTools(serverId: string): AiMcpToolMeta[] {
    return this.active.get(serverId)?.tools ?? []
  }

  /**
   * Build a confirmation request for a pending user server (stdio or
   * loopback-http). Main owns the nonce; the renderer only displays it + the
   * exact command/args (stdio) or URL (loopback-http) + risk. The nonce is
   * single-use, short-TTL, and bound to the commandFingerprint.
   *
   * Field presence is source-gated per the locked P4 contract:
   *   - user-stdio:     command + args present, url absent
   *   - user-loopback:  url present (exact endpoint), command/args absent
   *   - trusted-built-in: returns null (main enables directly, no prompt)
   */
  buildConfirmation(serverId: string): AiMcpConfirmationRequest | null {
    const server = this.deps.configRepository.get(serverId)
    if (!server) return null
    if (server.source !== 'user-stdio' && server.source !== 'user-loopback') return null
    // Invalidate any prior pending confirmation for this server (single pending).
    this.pending.delete(serverId)
    const nonce = randomUUID()
    const entry: PendingConfirmation = {
      serverId,
      nonce,
      commandFingerprint: server.commandFingerprint,
      expiresAt: Date.now() + AI_MCP_CONFIRMATION_TTL_MS,
      used: false,
    }
    this.pending.set(serverId, entry)
    const req: AiMcpConfirmationRequest = {
      serverId,
      nonce,
      source: server.source,
      transport: server.transport,
      commandFingerprint: server.commandFingerprint,
      riskNotice: server.source === 'user-stdio'
        ? '将启动本地 stdio 子进程，请确认命令来源可信'
        : '将连接 loopback HTTP 端点',
      expiresAt: entry.expiresAt,
    }
    if (server.source === 'user-stdio') {
      req.command = server.command ?? ''
      req.args = server.args ?? []
    } else {
      req.url = server.url ?? ''
    }
    return req
  }

  /**
   * Confirm activation of a user-stdio or user-loopback server. The nonce +
   * commandFingerprint must match a main-owned pending entry that is not
   * used/expired. A config change (new fingerprint — command/args change for
   * stdio, or URL change for loopback) invalidates the pending entry → reject.
   * Single-use: a second confirm with the same nonce is rejected. The renderer
   * cannot forge activation. On success the server is marked enabled (still
   * must call connect() / enable() to actually connect).
   */
  confirmActivation(serverId: string, nonce: string): { ok: true } | { ok: false; reason: string } {
    const server = this.deps.configRepository.get(serverId)
    if (!server) return { ok: false, reason: 'MCP 服务器不存在' }
    if (server.source !== 'user-stdio' && server.source !== 'user-loopback') {
      return { ok: false, reason: '内置 MCP 无需确认' }
    }
    const entry = this.pending.get(serverId)
    if (!entry) return { ok: false, reason: '无待确认的激活请求' }
    // Config-change invalidation: the fingerprint must match the pending entry.
    if (entry.commandFingerprint !== server.commandFingerprint) {
      this.pending.delete(serverId)
      return { ok: false, reason: '配置已变更，请重新确认' }
    }
    // Constant-time nonce compare (defense-in-depth; nonce is not a secret but
    // avoid timing oracle on the single-use token).
    const a = Buffer.from(nonce)
    const b = Buffer.from(entry.nonce)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: '确认凭据不匹配' }
    }
    if (entry.used) return { ok: false, reason: '确认凭据已使用' }
    if (Date.now() > entry.expiresAt) {
      this.pending.delete(serverId)
      return { ok: false, reason: '确认已过期，请重新确认' }
    }
    entry.used = true
    this.pending.delete(serverId)
    // Mark enabled but do NOT auto-connect (explicit connect via enable()).
    this.deps.configRepository.update(serverId, { enabled: true, status: 'disabled', error: undefined })
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Eligibility (called BEFORE persisting a candidate)
  // -------------------------------------------------------------------------

  /**
   * Validate a candidate MCP server config. Rejects remote/non-loopback, OAuth,
   * sampling, elicitation, shell mode, inherited arbitrary env, stdin injection,
   * oversize command/args. This is the single eligibility chokepoint.
   */
  checkEligibility(input: {
    transport: AiMcpTransport
    source?: AiMcpSource
    command?: string
    args?: string[]
    url?: string
    env?: unknown
  }): AiMcpEligibility {
    if (input.transport !== 'stdio' && input.transport !== 'loopback-http') {
      return { ok: false, reason: 'P4 仅支持 stdio 与 loopback HTTP 传输' }
    }
    // No inherited arbitrary env ever. The renderer may not pass env; main
    // spawns with a sanitized minimal env (PATH + SYSTEMROOT only) — never the
    // process env. Reject any caller-supplied env outright.
    if (input.env !== undefined) {
      return { ok: false, reason: '不允许自定义环境变量（最小化环境由主进程控制）' }
    }
    if (input.transport === 'stdio') {
      const cmd = input.command
      if (typeof cmd !== 'string' || !cmd.trim()) {
        return { ok: false, reason: 'stdio 命令不能为空' }
      }
      if (cmd.length > AI_MCP_MAX_COMMAND_LEN) {
        return { ok: false, reason: 'stdio 命令过长' }
      }
      // Reject shell metacharacters in the command itself — we spawn without
      // shell, but defense-in-depth against a path that triggers a shell.
      if (/[;&|`$<>\n\r]/.test(cmd)) {
        return { ok: false, reason: 'stdio 命令含非法字符' }
      }
      // Reject stdin-injection patterns in args (newline/control chars that
      // could break argv parsing or smuggle a second command).
      const args = input.args ?? []
      if (!Array.isArray(args) || args.length > AI_MCP_MAX_ARGS) {
        return { ok: false, reason: `参数数量超过上限（${AI_MCP_MAX_ARGS}）` }
      }
      for (const arg of args) {
        if (typeof arg !== 'string') return { ok: false, reason: '参数必须为字符串' }
        if (arg.length > AI_MCP_MAX_ARG_LEN) return { ok: false, reason: '参数过长' }
        // Shell-injection chars + control chars (newline/CR = stdin injection).
        // Plain spaces ARE allowed — we spawn without shell, args passed
        // directly, so spaces don't tokenize.
        if (/[;<>&|`$]/.test(arg) || /[\n\r]/.test(arg)) {
          return { ok: false, reason: '参数含 shell 元字符或控制字符，已拒绝' }
        }
      }
      return { ok: true }
    }
    // loopback-http
    const url = input.url
    if (typeof url !== 'string' || !url.trim()) {
      return { ok: false, reason: 'loopback HTTP URL 不能为空' }
    }
    if (!isLoopbackUrl(url)) {
      return { ok: false, reason: 'P4 仅允许 127.0.0.1/localhost 的 loopback HTTP' }
    }
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Add candidate (user-stdio) — stored disabled/pending, never auto-connect
  // -------------------------------------------------------------------------

  /**
   * Add a user-stdio candidate. Eligibility is enforced; the server is stored
   * disabled/pending-confirmation. A chat/model request is NEVER permission to
   * add/start a server — this is only called from the explicit IPC.
   */
  addUserStdioCandidate(input: {
    displayName: string
    command: string
    args: string[]
  }): { ok: true; server: AiMcpServerConfig } | { ok: false; reason: string } {
    const eligibility = this.checkEligibility({
      transport: 'stdio',
      source: 'user-stdio',
      command: input.command,
      args: input.args,
    })
    if (!eligibility.ok) return eligibility
    const commandFingerprint = fingerprintStdio(input.command, input.args)
    const server = this.deps.configRepository.add({
      displayName: input.displayName,
      transport: 'stdio',
      source: 'user-stdio',
      command: input.command,
      args: input.args,
      commandFingerprint,
    })
    return { ok: true, server }
  }

  /**
   * Add a loopback-HTTP candidate. Eligibility enforces 127.0.0.1/localhost
   * only, http only, no credentials/query/fragment. The server is stored
   * disabled/pending-confirmation (same confirmation flow as user-stdio — a
   * loopback server still runs code on this machine). A chat/model request is
   * NEVER permission to add/start a server.
   */
  addLoopbackCandidate(input: {
    displayName: string
    url: string
  }): { ok: true; server: AiMcpServerConfig } | { ok: false; reason: string } {
    const eligibility = this.checkEligibility({
      transport: 'loopback-http',
      source: 'user-loopback',
      url: input.url,
    })
    if (!eligibility.ok) return eligibility
    const commandFingerprint = fingerprintLoopback(input.url)
    const server = this.deps.configRepository.add({
      displayName: input.displayName,
      transport: 'loopback-http',
      source: 'user-loopback',
      url: input.url,
      commandFingerprint,
    })
    return { ok: true, server }
  }

  /**
   * Add (or refresh) the bundled RainTool MCP as a trusted built-in. The actual
   * launcher path is resolved by main at connect time (`resolveBundledLauncher`)
   * and is NEVER persisted or supplied by the renderer. Per the locked P4
   * contract, the trusted-built-in entry stores NO command/args/url — only the
   * stable identity label fingerprint `sha256("trusted-built-in:raintool-mcp")`,
   * which is identical across dev/packaged/reinstalls (unlike the launcher
   * path). Idempotent: if a trusted-built-in entry already exists, it is kept
   * as-is (the launcher is always resolved live, so no refresh is needed).
   */
  addBundledBuiltIn(): { ok: true; server: AiMcpServerConfig } | { ok: false; reason: string } {
    const launcher = this.deps.resolveBundledLauncher()
    if (!launcher) return { ok: false, reason: '未找到内置 RainTool MCP 启动器' }
    const existing = this.deps.configRepository.list().find((s) => s.source === 'trusted-built-in')
    // Stable identity label fingerprint — does NOT depend on the resolved
    // launcher path (which differs across dev/packaged/reinstalls).
    const commandFingerprint = FINGERPRINT_BUILT_IN()
    if (existing) {
      // The launcher is resolved live at connect time, so the persisted entry
      // never needs a command/args refresh. Return the existing entry as-is.
      return { ok: true, server: existing }
    }
    const server = this.deps.configRepository.add({
      displayName: 'RainTool 图纸 MCP（内置）',
      transport: 'stdio',
      source: 'trusted-built-in',
      // No command/args/url persisted — main resolves the launcher at connect.
      commandFingerprint,
    })
    return { ok: true, server }
  }

  // -------------------------------------------------------------------------
  // Connect / disconnect / reconnect / enable / disable
  // -------------------------------------------------------------------------

  /** Enable + connect a server (must be confirmed first if user-stdio/user-loopback). */
  async enable(serverId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const server = this.deps.configRepository.get(serverId)
    if (!server) return { ok: false, reason: 'MCP 服务器不存在' }
    if ((server.source === 'user-stdio' || server.source === 'user-loopback') && server.status === 'pending-confirmation') {
      return { ok: false, reason: '请先完成激活确认' }
    }
    if (!server.enabled) {
      this.deps.configRepository.update(serverId, { enabled: true })
    }
    return this.connect(serverId)
  }

  /** Disable + disconnect a server. Idempotent. */
  async disable(serverId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const server = this.deps.configRepository.get(serverId)
    if (!server) return { ok: false, reason: 'MCP 服务器不存在' }
    this.deps.configRepository.update(serverId, { enabled: false })
    await this.disconnect(serverId, 'disabled')
    return { ok: true }
  }

  /** Reconnect: disconnect then connect again. Idempotent. */
  async reconnect(serverId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const server = this.deps.configRepository.get(serverId)
    if (!server) return { ok: false, reason: 'MCP 服务器不存在' }
    if ((server.source === 'user-stdio' || server.source === 'user-loopback') && server.status === 'pending-confirmation') {
      return { ok: false, reason: '请先完成激活确认' }
    }
    await this.disconnect(serverId, 'reconnecting')
    return this.connect(serverId)
  }

  /**
   * Connect to a server. Resolves the launcher for the built-in (main-only),
   * constructs the SDK v1 transport (StdioClientTransport without shell +
   * sanitized minimal env + stderr pipe, or StreamableHTTPClientTransport for
   * loopback), connects the Client with a bounded timeout, and discovers tools.
   * All server-provided data (names/descriptions/schemas/instructions) is
   * treated as untrusted: instructions are discarded (never alter prompt/policy),
   * tool metadata is redacted + truncated, and generic tools are inventory-only.
   */
  private async connect(serverId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const server = this.deps.configRepository.get(serverId)
    if (!server) return { ok: false, reason: 'MCP 服务器不存在' }
    // Idempotency: already connected → no-op success.
    if (this.active.has(serverId)) return { ok: true }
    // In-flight guard: prevent two concurrent enable()/reconnect() calls from
    // each passing the active.has check and spawning two transports (race →
    // duplicate process). A second caller gets a no-op success.
    if (this.connecting.has(serverId)) return { ok: true }
    this.connecting.add(serverId)
    this.setStatus(serverId, 'connecting')
    let client: Client | null = null
    let stderrBuf: BoundedStderrSink = new BoundedStderrSink(AI_MCP_MAX_STDIO_CAPTURE_BYTES)
    try {
      const built = await this.buildTransport(server)
      const transport = built.transport
      stderrBuf = built.stderrBuf
      client = new Client({ name: 'RainTool', version: '1.0.0' }, { capabilities: {} })
      const connection: ActiveConnection = { serverId, client, transport, tools: [], stderrBuf, closing: false }
      // Connect with a bounded timeout.
      await withTimeout(client.connect(transport), AI_MCP_CONNECT_TIMEOUT_MS, 'MCP 连接超时')
      // Discover tools. Server-provided data is UNTRUSTED — redact + truncate,
      // cap tool count, never let instructions alter policy.
      const result = await withTimeout(client.listTools(), AI_MCP_CONNECT_TIMEOUT_MS, 'MCP 工具发现超时')
      const tools = sanitizeTools(serverId, result.tools ?? [])
      connection.tools = tools
      this.active.set(serverId, connection)
      this.deps.configRepository.update(serverId, { status: 'connected', toolCount: tools.length, error: undefined })
      this.emit({ serverId, status: 'connected', toolCount: tools.length })
      return { ok: true }
    } catch (error) {
      // Failed-connect cleanup: close the half-spawned client/transport so the
      // child process (stdio) does not leak. close() is best-effort — a
      // transport that never started throws here; swallow + continue to the
      // error status. The app must not crash on a failed connect.
      if (client) {
        try { await client.close() } catch { /* transport may not have started */ }
      }
      // Outward reason is sanitizeError(error) ONLY. The captured stderrBuf is
      // main-internal diagnostic data and NEVER flows to config.error,
      // event.error, or the renderer — no server output, even redacted, crosses
      // the trust boundary. The reason is short, factual, actionable.
      const reason = sanitizeError(error)
      this.deps.configRepository.update(serverId, { status: 'error', error: reason })
      this.emit({ serverId, status: 'error', toolCount: 0, error: reason })
      return { ok: false, reason }
    } finally {
      this.connecting.delete(serverId)
    }
  }

  /**
   * Build the SDK transport for a server. For the trusted built-in, resolves
   * the actual launcher path via main (never a renderer path). For stdio,
   * spawns WITHOUT shell with a sanitized minimal env (PATH + SYSTEMROOT on
   * win32) — never the inherited process env. stderr is piped + captured to a
   * BoundedStderrSink (byte-capped, main-internal). The sink is NEVER used in
   * the outward error: connect()'s catch composes `reason = sanitizeError(error)`
   * only. The sink exists for future main-side diagnostics; no stderr (even
   * redacted) crosses to config/event/renderer.
   */
  private async buildTransport(
    server: AiMcpServerConfig,
  ): Promise<{ transport: StdioClientTransport | StreamableHTTPClientTransport; stderrBuf: BoundedStderrSink }> {
    if (server.transport === 'loopback-http') {
      if (!server.url) throw new Error('loopback HTTP URL 缺失')
      // Re-check loopback at connect time (defense-in-depth).
      if (!isLoopbackUrl(server.url)) throw new Error('仅允许 loopback HTTP')
      const transport = new StreamableHTTPClientTransport(new URL(server.url))
      return { transport, stderrBuf: new BoundedStderrSink(AI_MCP_MAX_STDIO_CAPTURE_BYTES) }
    }
    // stdio
    let command = server.command ?? ''
    let args = server.args ?? []
    if (server.source === 'trusted-built-in') {
      const launcher = this.deps.resolveBundledLauncher()
      if (!launcher) throw new Error('未找到内置 RainTool MCP 启动器')
      command = launcher.command
      args = launcher.args
    } else {
      // User-stdio: the stored command must be a real executable path. Validate
      // it is absolute (no PATH lookup → no PATH hijack) and has no shell chars
      // (already checked at eligibility, but re-check at connect).
      if (!path.isAbsolute(command)) throw new Error('用户 stdio 命令必须为绝对路径')
      if (/[;&|`$<>\n\r]/.test(command)) throw new Error('stdio 命令含非法字符')
    }
    // Bounded stderr capture sink (byte-capped, UTF-8-boundary tail). Raw
    // stderr NEVER crosses to config/event/renderer — the connect() catch
    // composes `reason = sanitizeError(error)` only. The sink is main-internal
    // for future diagnostics.
    const stderrBuf = new BoundedStderrSink(AI_MCP_MAX_STDIO_CAPTURE_BYTES)
    const transport = new StdioClientTransport({
      command,
      args,
      // Sanitized minimal env — NEVER the inherited process env. Only PATH
      // (needed to find node/shell-less helpers) and SYSTEMROOT on win32.
      env: sanitizedEnv(),
      stderr: 'pipe',
    })
    // The SDK returns a PassThrough stream immediately when stderr:'pipe' is
    // set. Pipe chunks into the bounded sink. Cast via unknown: the SDK returns
    // a Node Stream, not ReadableStream; we only need the 'on' surface.
    const stderrStream = transport.stderr
    if (stderrStream && typeof (stderrStream as { on?: unknown }).on === 'function') {
      const emitter = stderrStream as unknown as { on(ev: 'data', cb: (chunk: Buffer) => void): void }
      emitter.on('data', (chunk: Buffer) => {
        stderrBuf.append(chunk)
      })
    }
    return { transport, stderrBuf }
  }

  /** Disconnect a server. Idempotent (closing flag prevents double-close). */
  async disconnect(serverId: string, reason: 'disabled' | 'reconnecting' | 'user' | 'quit'): Promise<void> {
    const conn = this.active.get(serverId)
    if (!conn) {
      // No active connection — just reflect status (unless already error/removed).
      const server = this.deps.configRepository.get(serverId)
      if (server && server.status === 'connected') {
        this.setStatus(serverId, reason === 'quit' ? 'disconnected' : 'disabled')
      }
      return
    }
    if (conn.closing) return
    conn.closing = true
    try {
      await conn.client.close()
    } catch {
      // close() may throw if the transport already errored; ignore.
    }
    this.active.delete(serverId)
    if (reason !== 'reconnecting') {
      this.setStatus(serverId, reason === 'quit' ? 'disconnected' : 'disabled')
    }
  }

  /** Disconnect every active connection (app quit / shutdown). Idempotent. */
  async disconnectAll(): Promise<void> {
    const ids = [...this.active.keys()]
    await Promise.all(ids.map((id) => this.disconnect(id, 'quit')))
    this.pending.clear()
  }

  /** Delete a server config: disconnect first, then remove from persistence. */
  async delete(serverId: string): Promise<boolean> {
    await this.disconnect(serverId, 'user')
    this.pending.delete(serverId)
    return this.deps.configRepository.delete(serverId)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private setStatus(serverId: string, status: AiMcpServerConfig['status'], error?: string): void {
    this.deps.configRepository.update(serverId, { status, error })
    this.emit({
      serverId,
      status,
      toolCount: this.active.get(serverId)?.tools.length ?? 0,
      error,
    })
  }

  private purgeExpiredConfirmations(): void {
    const now = Date.now()
    for (const [id, entry] of this.pending) {
      if (now > entry.expiresAt || entry.used) this.pending.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — re-exported from ai-mcp-helpers.ts (shared with the config
// repository so eligibility-at-add and validateServerEntry-at-read enforce the
// SAME canonical fingerprint form + loopback rules). See ai-mcp-helpers.ts.
// ---------------------------------------------------------------------------

export { fingerprintStdio, isLoopbackUrl, sha256Hex, fingerprintLoopback, FINGERPRINT_BUILT_IN } from './ai-mcp-helpers.js'

/** Sanitized minimal env for spawning stdio MCP (never the process env). */
export function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  if (process.platform === 'win32' && process.env.SYSTEMROOT) {
    env.SYSTEMROOT = process.env.SYSTEMROOT
  }
  return env
}

/** Bounded + redacted safe error message from any thrown value. */
export function sanitizeError(error: unknown): string {
  let msg = error instanceof Error ? error.message : String(error)
  msg = redactSecrets(msg).slice(0, 300)
  // Strip any restricted content (defense-in-depth; an MCP server could echo
  // a secret in its error).
  const sens = classifySensitivity(msg)
  if (sens.sensitivity === 'restricted') {
    return `MCP 连接失败（${sens.reason}）`
  }
  return msg || 'MCP 连接失败'
}

/**
 * Sanitize discovered tools into safe inventory metadata. Server-provided
 * names/descriptions are UNTRUSTED: redacted + truncated, capped in count.
 * The schema is NOT stored (it could carry injection); only a boolean presence
 * is implied. All tools are policy:'not-executable' in P4.
 */
export function sanitizeTools(serverId: string, tools: Array<{ name: string; description?: string }>): AiMcpToolMeta[] {
  const capped = tools.slice(0, AI_MCP_MAX_TOOLS_PER_SERVER)
  return capped.map((t) => {
    const name = String(t.name ?? '').slice(0, 128)
    let description: string | undefined
    if (t.description) {
      const d = redactSecrets(String(t.description)).slice(0, 500)
      description = d || undefined
    }
    return {
      id: `${serverId}.${name}`,
      serverId,
      name,
      description,
      policy: 'not-executable' as const,
    }
  })
}

/** Run a promise with a timeout; rejects with the given message on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

// Silence unused-import lint for spawn (reserved for future direct-spawn path
// if the SDK transport is bypassed; currently the SDK spawns internally).
void spawn
void AI_MCP_CALL_TIMEOUT_MS
