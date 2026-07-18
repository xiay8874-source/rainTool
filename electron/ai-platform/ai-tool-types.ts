// P3 Tool / Approval / Audit types (DTOs + events).
//
// These types cross the Electron IPC boundary: every field is JSON-serializable
// and is what the renderer sees. Raw API keys, raw tool payloads, unredacted
// tool errors, and restricted content must NEVER appear in these types. Every
// summary/preview/error string is routed through redactSecrets +
// classifySensitivity before it lands here.
//
// P3 adds internal tools + an approval workflow + an audit log ON TOP of P1/P2.
// It does NOT add MCP, an Agent loop, subagents, Git, filesystem, shell, or
// network tools.
//
// TOOL INVOCATION CONTRACT (correction 4 — explicit, deterministic, P3-only):
// There are TWO distinct tool paths, and they must not be confused:
//
//   1. DIRECT INVOCATION (P3, implemented): the renderer (or a test) explicitly
//      requests a tool call via AiStartRunRequest.toolCalls. The run stays in
//      `chat` mode — direct invocation does NOT widen P1_SUPPORTED_RUN_MODES.
//      The runtime resolves + Zod-validates each call, runs the tool state
//      machine, and emits tool/approval events. The MODEL IS NEVER INVOLVED:
//      we do not pass `tools` to streamChat, so a provider that lacks tool
//      calling is fine (plan §9: "模型不支持 tool calling → 自动降级为对话，
//      不伪造工具能力"). Direct invocation has its OWN capability gate:
//      toolsForMode(mode, toolCalling) filters which tool RISKS a mode may
//      directly invoke. chat → NO tools (zero); assistant → read|propose;
//      agent → read|propose|write (never dangerous). A profile with
//      toolCalling:false downgrades agent→assistant. So in chat mode (the only
//      P3-supported mode), direct invocation of ANY tool is blocked UNLESS the
//      runtime is explicitly told this is a direct-invocation run — which it is
//      by the presence of `toolCalls`. To keep chat-mode direct invocation
//      reachable for the JSON Workbench (read/propose/write demo), P3 introduces
//      a SEPARATE, explicit gate: AiDirectInvocationGate. See
//      P3_DIRECT_INVOCATION_ALLOWED below. This does NOT pretend the model
//      supports tools; it is an explicit, audited, renderer-initiated path.
//
//   2. MODEL TOOL CALLING (NOT implemented in P3): the provider's streamChat
//      would be passed `tools` and the model would emit tool_calls. P3 does
//      NOT do this. It is reserved for a future phase that widens
//      P1_SUPPORTED_RUN_MODES to assistant/agent with a real loop.

import type { AiRunMode, AiToolRisk } from './ai-types.js'

// ---------------------------------------------------------------------------
// Tool identifiers + metadata
// ---------------------------------------------------------------------------

/**
 * Stable tool id. Must be `<componentId>.<action>` (e.g. `json.inspect-selection`).
 * The componentId prefix scopes the tool to a component's contributions.
 */
export type AiToolId = string

/** Component that owns a tool (scopes write targets + context contributions). */
export type AiComponentId = 'json-workbench' | 'diagram' | 'app'

/** Metadata about a tool that is safe to return to the renderer (no executor). */
export interface AiToolMeta {
  id: AiToolId
  title: string
  componentId: AiComponentId
  risk: AiToolRisk
  /** Short human description of what the tool does (no args, no secrets). */
  description: string
}

// ---------------------------------------------------------------------------
// Tool execution contract (main-process only; executor never crosses IPC)
// ---------------------------------------------------------------------------

/**
 * Result of a write tool's apply-to-target call (main-coordinated cross-process
 * flow, correction). The runtime emits an apply-request event to the active
 * renderer, awaits a guarded ack, and resolves here. The tool executor never
 * touches the editor directly — there is no module-global callback.
 */
export type AiApplyToTargetResult =
  | { ok: true; applied: boolean }
  | { ok: false; reason: string; category: AiToolErrorCategory }

/** Context handed to a tool executor. Never carries keys/credentials. */
export interface AiToolExecCtx {
  runId: string
  toolCallId: string
  /**
   * Emit a non-terminal run event (tool-started/tool-completed/tool-failed).
   * The executor MUST NOT emit terminal events (completed/failed/cancelled) —
   * the runtime owns the terminal via commitTerminal.
   */
  emit: (event: AiToolRunEvent) => void
  /**
   * P3 cross-process apply (correction). For a `write` tool whose approval was
   * consumed, the executor calls this with the proposal text + the source
   * revision hash. The runtime emits an `apply-request` event to the active
   * renderer, awaits a guarded `ai:apply:ack` IPC tied to the applyId, and
   * resolves. The renderer may apply ONLY if its current editor revision
   * matches; a stale editor refuses. Main rejects duplicate/unknown/mismatched/
   * stale acks. There is NO renderer-initiated arbitrary "success/execution"
   * call — only a guarded ack tied to the pending one-shot invocation.
   */
  applyToTarget: (
    proposal: string,
    revision: string,
    targetScope: string,
    contentHash: string,
  ) => Promise<AiApplyToTargetResult>
  /**
   * Create a read-only proposal artifact (kind=json/markdown/code) in the P2
   * artifact repository. Available only when the runtime is wired with an
   * artifact repository; undefined otherwise (executors must handle absence).
   *
   * The artifact is a PROPOSAL — preview/copy only, NO apply/writeback. A
   * `propose`-risk tool calls this to persist its output so the user can review
   * it in the Artifacts drawer; the returned `artifactRef` flows back through
   * the tool result → `tool-completed` event → UI. The content is sanitized +
   * sensitivity-checked by the repository (restricted content is rejected);
   * the executor never sees the raw key/credential.
   *
   * Failure contract (NOT best-effort): when the repository is wired, a
   * rejected artifact (restricted content, invalid JSON, oversize) THROWS. The
   * executor MUST catch + map to a `tool-failed` result (restricted-content /
   * executor-error) — it must NOT swallow the error and return a preview
   * without the artifactRef. The preview-only fallback applies ONLY when
   * `createArtifact` is undefined (runtime not wired with a repository).
   */
  createArtifact?: (
    input: { kind: 'json' | 'markdown' | 'code'; title: string; content: string; language?: string },
  ) => Promise<string>
}

/**
 * Tool result. `summary` is a short safe label; `preview` is an optional
 * longer safe snippet (e.g. repaired JSON). Both are redacted before use.
 * `artifactRef` optionally points at a created read-only artifact.
 */
export type AiToolResult =
  | { ok: true; summary: string; preview?: string; artifactRef?: string }
  | { ok: false; redactedError: string; category: AiToolErrorCategory }

export type AiToolErrorCategory =
  | 'invalid-input'
  | 'no-approval'
  | 'approval-rejected'
  | 'approval-expired'
  | 'approval-used'
  | 'approval-cancelled'
  | 'stale-target'
  | 'hash-mismatch'
  | 'scope-mismatch'
  | 'executor-error'
  | 'restricted-content'

// ---------------------------------------------------------------------------
// Approval contract
// ---------------------------------------------------------------------------

/** A write tool's request for approval, bound to the exact execution target. */
export interface AiApprovalRequest {
  runId: string
  toolCallId: string
  toolId: AiToolId
  risk: AiToolRisk
  /** Canonical JSON of the Zod-validated input (deterministic compare). */
  normalizedInput: string
  /** Target component + scoped action, e.g. `json-workbench:editor-input`. */
  targetScope: string
  /** sha256 of the proposed new content (what the tool will write). */
  contentHash: string
  /** sha256 of the source/target snapshot the proposal was built against. */
  revision: string
  /** Safe summary of what will happen (redacted). */
  impactSummary: string
  /** Safe preview of the proposed content (redacted, truncated). */
  impactPreview: string
}

export type AiApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'used'
  | 'cancelled'

/** An approval token. The token id is the only field the renderer needs to decide. */
export interface AiApprovalToken {
  token: string
  request: AiApprovalRequest
  status: AiApprovalStatus
  createdAt: number
  decidedAt?: number
  expiresAt: number
  /** User's reason on reject (recommended on approve). Safe (redacted). */
  reason?: string
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AiAuditKind =
  | 'tool-proposed'
  | 'tool-approved'
  | 'tool-rejected'
  | 'tool-expired'
  | 'tool-cancelled'
  | 'tool-started'
  | 'tool-completed'
  | 'tool-failed'
  | 'run-completed'
  | 'run-failed'
  | 'run-cancelled'

/** A single audit entry. Every text field is redacted + sensitivity-checked. */
export interface AiAuditEntry {
  at: number
  runId: string
  kind: AiAuditKind
  toolCallId?: string
  toolId?: string
  risk?: AiToolRisk
  /** Safe one-line summary (no raw input/payload/secret). */
  summary?: string
  redactedError?: string
  category?: AiToolErrorCategory
}

/** Filter for the read-only audit list IPC. */
export interface AiAuditFilter {
  runId?: string
  toolId?: string
  kind?: AiAuditKind
  /** Max entries to return (newest first). Default 200. */
  limit?: number
}

// ---------------------------------------------------------------------------
// Direct tool invocation (renderer/test-explicit; NOT model tool calling)
// ---------------------------------------------------------------------------

/**
 * A tool call explicitly requested by the renderer (or a test). The runtime
 * resolves + validates `rawInput` via the registry's Zod schema, then runs the
 * tool state machine. The model is never involved — this is the P3 direct
 * invocation contract for UIs/tests, honoring "do not pretend the model
 * supports tools".
 */
export interface AiDirectToolCall {
  toolId: AiToolId
  /** Unvalidated input from the renderer; Zod-parsed before execution. */
  rawInput: unknown
}

// ---------------------------------------------------------------------------
// Tool + approval run events (extend the AiRunEvent union in ai-types.ts)
// ---------------------------------------------------------------------------

export type AiToolRunEventType =
  | 'tool-call-proposed'
  | 'approval-required'
  | 'approval-resolved'
  | 'tool-started'
  | 'tool-completed'
  | 'tool-failed'
  | 'apply-request'

/** A non-terminal tool/approval/apply event. Shares the run-event envelope. */
export type AiToolRunEvent =
  | { runId: string; sequence: number; type: 'tool-call-proposed'; at: number; payload: { toolCallId: string; toolId: string; risk: AiToolRisk; inputSummary: string } }
  | { runId: string; sequence: number; type: 'approval-required'; at: number; payload: { toolCallId: string; token: string; toolId: string; risk: AiToolRisk; impactSummary: string; impactPreview: string; targetScope: string; contentHash: string; expiresAt: number } }
  | { runId: string; sequence: number; type: 'approval-resolved'; at: number; payload: { toolCallId: string; token: string; decision: 'approved' | 'rejected'; reason?: string } }
  | { runId: string; sequence: number; type: 'tool-started'; at: number; payload: { toolCallId: string; toolId: string } }
  | { runId: string; sequence: number; type: 'tool-completed'; at: number; payload: { toolCallId: string; toolId: string; summary: string; preview?: string; artifactRef?: string } }
  | { runId: string; sequence: number; type: 'tool-failed'; at: number; payload: { toolCallId: string; toolId: string; redactedError: string; category: AiToolErrorCategory } }
  /**
   * P3 apply-request (correction: main-coordinated cross-process apply). Main
   * emits this AFTER consume() passes, asking the active trusted renderer to
   * apply the proposal to the narrow editor scope. The renderer MUST verify its
   * current editor revision matches `revision` before applying, then ack via
   * the guarded `ai:apply:ack` IPC with the `applyId`. Main rejects
   * duplicate/unknown/mismatched/stale acks. This event carries the proposal
   * text (it already passed sensitivity+hash checks at approval time).
   */
  | { runId: string; sequence: number; type: 'apply-request'; at: number; payload: { applyId: string; toolCallId: string; toolId: string; targetScope: string; contentHash: string; revision: string; proposal: string; expiresAt: number } }

// ---------------------------------------------------------------------------
// Mode → tool risk capability matrix (plan §8.5 / §2.4)
// ---------------------------------------------------------------------------

/**
 * Tools available to a run mode for MODEL-INITIATED tool calling (future).
 * Honors §8.5:
 *   - chat → NO tools (zero)
 *   - assistant → read | propose only
 *   - agent → read | propose | write (NEVER dangerous)
 * A profile with toolCalling:false downgrades agent → assistant.
 *
 * NOTE: P3 does NOT implement model tool calling. This matrix is the future
 * contract + is reused by directInvocationAllowed below to filter which risks
 * a direct-invocation run may use.
 */
export function toolsForMode(
  mode: AiRunMode,
  toolCalling: boolean,
): ReadonlySet<AiToolRisk> {
  if (mode === 'chat') return new Set()
  if (mode === 'assistant') return new Set(['read', 'propose'])
  // agent
  if (!toolCalling) return new Set(['read', 'propose']) // downgrade
  return new Set(['read', 'propose', 'write'])
}

/**
 * P3 direct-invocation capability gate (correction 4). This is the EXPLICIT,
 * deterministic gate for renderer/test-requested tool calls. It is separate
 * from model tool calling (which P3 does not implement).
 *
 * P3 deliberate decision: direct invocation is allowed in ALL modes (including
 * `chat`), because it is an explicit, audited, renderer-initiated action — not
 * the model calling tools. The risk filter still applies: `dangerous` is NEVER
 * allowed. `write` is allowed (after approval) so the JSON Workbench apply
 * demo is reachable. This does NOT widen P1_SUPPORTED_RUN_MODES and does NOT
 * pretend the provider supports tools.
 *
 * Returns the set of risks this run may directly invoke. The runtime rejects
 * any direct tool call whose risk is not in this set.
 */
export function directInvocationAllowed(
  mode: AiRunMode,
  _toolCalling: boolean,
): ReadonlySet<AiToolRisk> {
  // P3: direct invocation allows read | propose | write in every mode.
  // `dangerous` is never allowed (no dangerous tools exist in P3 anyway).
  // `mode` is accepted to keep the signature stable for a future phase that
  // may tighten this per-mode.
  void mode
  return new Set(['read', 'propose', 'write'])
}

/** P3 approval TTL (5 min). A pending write must be decided before this. */
export const AI_APPROVAL_TTL_MS = 5 * 60 * 1000
/** P3 audit log cap (FIFO rotation). */
export const AI_AUDIT_MAX_ENTRIES = 5000
/** P3 apply-request ack timeout (30s). The renderer must ack within this. */
export const AI_APPLY_ACK_TIMEOUT_MS = 30 * 1000

/**
 * The guarded ack the renderer sends via `ai:apply:ack` after handling an
 * apply-request. `applied:false` with a reason means the renderer refused
 * (e.g. stale editor revision, component gone). Main validates the applyId
 * against its pending one-shot applies AND verifies the ack's
 * targetScope/contentHash/revision match the stored pending request — a
 * duplicate/unknown/mismatched ack is rejected. There is NO arbitrary
 * "execute" call — only this ack tied to the pending apply.
 *
 * The ack echoes the apply-request's targetScope/contentHash/revision so main
 * can confirm the renderer applied the exact proposal it was given (no swap).
 */
export interface AiApplyAck {
  applyId: string
  applied: boolean
  /** The scope the renderer applied to (must match the pending request). */
  targetScope: string
  /** sha256 of the content the renderer applied (must match the pending request). */
  contentHash: string
  /** The source revision the renderer saw (must match the pending request). */
  revision: string
  /** Required when applied:false (why the renderer refused). Safe (redacted). */
  reason?: string
}
