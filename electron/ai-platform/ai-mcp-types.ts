// P4 MCP Client — DTOs that cross the IPC boundary.
//
// Every field here is JSON-serializable and is what the renderer sees. The
// renderer NEVER spawns/connects an MCP server itself — it only sends
// validated config candidates + confirmation nonces, and receives safe
// status/tool metadata. Raw tokens, env secrets, raw stderr, server
// instructions, and tool raw payloads NEVER appear in these types.
//
// P4 scope (plan §6.3 / §P4): ONLY
//   (a) the RainTool bundled known local stdio MCP endpoint (trusted built-in),
//   (b) user-added local stdio MCP (pending confirmation until activated),
//   (c) loopback 127.0.0.1/localhost HTTP only.
// Explicitly rejected: remote hosts, non-loopback, OAuth, sampling, elicitation,
// shell mode, inherited arbitrary env. See ai-mcp-manager.ts eligibility.

/** Transport kind. P4 supports stdio + loopback HTTP only. */
export type AiMcpTransport = 'stdio' | 'loopback-http'

/**
 * Trust/source classification. The renderer cannot set `trusted-built-in` —
 * only the main process marks the bundled RainTool MCP as a trusted built-in
 * (its actual packaged/dev launcher path is selected by main, never a renderer
 * path). User-added stdio servers are `user-stdio`; user-added loopback HTTP
 * servers are `user-loopback`. Both user-* sources start disabled/pending
 * until the renderer confirms the exact command/args (stdio) or URL (loopback).
 */
export type AiMcpSource = 'trusted-built-in' | 'user-stdio' | 'user-loopback'

/**
 * Connection status of an MCP server. The UI shows this verbatim; it never
 * shows raw stderr — `error` is a short factual actionable message (redacted).
 *
 *   - `pending-confirmation`: user-stdio candidate awaiting explicit renderer
 *     confirmation of the exact command/args/source/risk. Main owns the
 *     single-use TTL nonce; config changes invalidate it.
 *   - `disabled`: confirmed but not enabled (or disabled by the user).
 *   - `connecting`: enable/reconnect in progress.
 *   - `connected`: transport up + tools discovered.
 *   - `error`: connection failed; `error` carries a safe reason.
 *   - `disconnected`: explicitly disconnected by the user or on quit.
 */
export type AiMcpStatus =
  | 'pending-confirmation'
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected'

/**
 * Persisted MCP server metadata. Stored under <userData>/ai/mcp-servers.json.
 * Metadata ONLY: never tokens, env secrets, raw stderr, server instructions,
 * or tool raw payloads. The `commandFingerprint` binds the confirmation to the
 * exact command/args so a config change invalidates a pending confirmation.
 */
export interface AiMcpServerConfig {
  id: string
  displayName: string
  transport: AiMcpTransport
  source: AiMcpSource
  enabled: boolean
  /** ISO timestamp (ms). */
  createdAt: number
  updatedAt: number
  /**
   * For stdio: the executable command (e.g. path to the launcher). For the
   * trusted built-in this is a stable label ("raintool-bundled"), NOT a path —
   * main resolves the actual packaged/dev launcher path itself.
   * For loopback-http: the base URL (must be 127.0.0.1/localhost).
   */
  command?: string
  /** For stdio: argv (bounded length, no shell metachars validated at add). */
  args?: string[]
  /** For loopback-http: the base URL. */
  url?: string
  /**
   * sha256 of the canonical (command + args) for stdio, or the URL for
   * loopback-http. Binds the confirmation nonce to the exact config; a config
   * change produces a new fingerprint + invalidates any pending nonce.
   */
  commandFingerprint: string
  /** Last known tool count (updated on successful discovery). */
  toolCount: number
  /** Last connection status. */
  status: AiMcpStatus
  /** Safe error reason when status === 'error' (redacted, no stderr/secrets). */
  error?: string
}

/** Safe tool metadata returned to the renderer (no executor, no raw schema). */
export interface AiMcpToolMeta {
  /** `<serverId>.<toolName>` — namespaced; the toolName is UNTRUSTED server data. */
  id: string
  serverId: string
  /** Untrusted server-provided tool name. */
  name: string
  /** Untrusted server-provided description (truncated + redacted). */
  description?: string
  /**
   * P4 policy: generic discovered external tools are inventory-only and NOT
   * executable. 'not-executable' is the only value in P4. A future phase may
   * add explicit main-process policy adapters that promote a tool to
   * 'read'/'propose'/'write' under the P3 approval gate.
   */
  policy: 'not-executable'
}

/**
 * A main-owned confirmation request for activating a user-stdio or
 * user-loopback server. The nonce is single-use, short-TTL, and bound to the
 * commandFingerprint. The renderer displays the exact command/args (stdio) OR
 * URL (loopback) plus source/risk, and calls
 * `aiMcpConfirmActivation(serverId, nonce)` — it cannot forge activation
 * because the nonce + fingerprint must match a main-owned pending entry.
 *
 * Field presence is source-gated:
 *   - user-stdio:     `command` + `args` present, `url` absent
 *   - user-loopback:  `url` present (exact endpoint URL), `command`/`args` absent
 *   - trusted-built-in: never issues a confirmation (main enables directly)
 */
export interface AiMcpConfirmationRequest {
  serverId: string
  /** Main-owned single-use short-TTL nonce. Renderer echoes this back on confirm. */
  nonce: string
  source: 'user-stdio' | 'user-loopback'
  transport: 'stdio' | 'loopback-http'
  /** The exact command + args the stdio server will run with (display-only). */
  command?: string
  args?: string[]
  /** The exact loopback endpoint URL (display-only). */
  url?: string
  /** sha256 bound to this exact config. */
  commandFingerprint: string
  /** Human-readable risk notice. */
  riskNotice: string
  /** Epoch ms when the nonce expires. */
  expiresAt: number
}

/** MCP server list event payload (status change → renderer). */
export interface AiMcpServerEvent {
  serverId: string
  status: AiMcpStatus
  toolCount: number
  error?: string
}

/** P4 confirmation TTL (2 min). A pending activation must be confirmed before this. */
export const AI_MCP_CONFIRMATION_TTL_MS = 2 * 60 * 1000
/** P4 connect timeout (10s). */
export const AI_MCP_CONNECT_TIMEOUT_MS = 10 * 1000
/** P4 per-call timeout (30s) — reserved for a future executable-tool phase. */
export const AI_MCP_CALL_TIMEOUT_MS = 30 * 1000
/** P4 max tools discovered per server (defense-in-depth). */
export const AI_MCP_MAX_TOOLS_PER_SERVER = 200
/** P4 max command length (chars). */
export const AI_MCP_MAX_COMMAND_LEN = 1024
/** P4 max args count. */
export const AI_MCP_MAX_ARGS = 32
/** P4 max single arg length (chars). */
export const AI_MCP_MAX_ARG_LEN = 4096
/**
 * P4 max stderr captured by the main-internal BoundedStderrSink (bytes). The
 * sink holds the byte-capped UTF-8-boundary tail of stderr for future main-side
 * diagnostics ONLY. It is NEVER used in the outward error: connect()'s catch
 * composes `reason = sanitizeError(error)` only — no stderr (even redacted)
 * crosses to config/event/renderer.
 */
export const AI_MCP_MAX_STDIO_CAPTURE_BYTES = 4096
