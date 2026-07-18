// P3 Approval Manager — main-process, single-use TTL write-tool approval.
//
// A `write` tool may NOT execute without a valid, matching approval. The
// approval is bound to: runId, toolCallId, toolId, the canonical (Zod-parsed)
// normalizedInput, the targetScope, the contentHash (what will be written),
// and the revision (source/target snapshot the proposal was built against).
//
// Lifecycle: pending → approved|rejected (via decide, the ONLY approve path,
// behind assertTrustedRenderer) → used (via consume, after a successful match).
// Expired/cancelled tokens can never be consumed. consume is default-deny:
// any mismatch (status, expiry, input, hash, scope, revision) → reject, no
// execution. A token is single-use: a second consume fails.
//
// The renderer can call decide(token, approved, reason) — it CANNOT call
// consume. consume is runtime-internal. So there is no renderer bypass.

import { createHash, randomUUID } from 'node:crypto'
import {
  AI_APPROVAL_TTL_MS,
  type AiApprovalRequest,
  type AiApprovalStatus,
  type AiApprovalToken,
} from './ai-tool-types.js'
import { sanitizeToolText } from './ai-tool-registry.js'

/** Max length of an approval reason (after sanitization). */
const APPROVAL_REASON_MAX = 500

/** Result of consuming an approval token (runtime-internal). */
export type AiConsumeResult =
  | { ok: true }
  | { ok: false; reason: string; status: AiApprovalStatus }

/** Result of a decide() call: the updated token, or a validation error. */
export type AiDecideResult =
  | { ok: true; token: AiApprovalToken }
  | { ok: false; reason: string }

export class AiApprovalManager {
  private readonly tokens = new Map<string, AiApprovalToken>()

  /**
   * Create a pending approval token for a write tool. Returns the token id the
   * renderer needs to decide. The token expires after AI_APPROVAL_TTL_MS.
   */
  propose(request: AiApprovalRequest): AiApprovalToken {
    const now = Date.now()
    const token: AiApprovalToken = {
      token: `apr_${randomUUID()}`,
      request,
      status: 'pending',
      createdAt: now,
      expiresAt: now + AI_APPROVAL_TTL_MS,
    }
    this.tokens.set(token.token, token)
    return token
  }

  /**
   * The ONLY approve path. Called by the IPC handler (assertTrustedRenderer-
   * guarded). Flips pending → approved|rejected with a reason.
   *
   * Reason rules (correction 3):
   *   - REJECT requires a non-empty reason (the model/conversation gets a clear
   *     safe explanation; a silent reject is not allowed). Approve reason is
   *     optional/recommended.
   *   - The reason is sanitized (redactSecrets + classifySensitivity). A
   *     restricted reason is rejected — it would leak a secret into the audit
   *     log / model feedback. Overlong reasons are truncated.
   *   - Returns AiDecideResult so the IPC layer can throw on validation
   *     failure (no silent accept of an invalid decide).
   */
  decide(tokenId: string, approved: boolean, reason?: string): AiDecideResult {
    const token = this.tokens.get(tokenId)
    if (!token) {
      return { ok: false, reason: '审批令牌不存在' }
    }
    // Only a pending token can be decided.
    if (token.status !== 'pending') {
      return { ok: false, reason: `审批令牌已不可决定（状态：${token.status}）` }
    }
    // If already past TTL at decide time, mark expired (not approved/rejected).
    if (Date.now() > token.expiresAt) {
      token.status = 'expired'
      return { ok: true, token }
    }
    // REJECT requires a non-empty reason. APPROVE reason is optional.
    let safeReason: string | undefined
    if (reason !== undefined && reason !== null) {
      safeReason = sanitizeToolText(reason, APPROVAL_REASON_MAX)
      // sanitizeToolText replaces restricted content with a safe placeholder;
      // if the reason was restricted, the placeholder is non-empty so it won't
      // trip the reject-empty check below. But we explicitly reject a reason
      // that came back as the restricted-placeholder — it means the user tried
      // to paste a secret, which we never want in the audit/model feedback.
      if (safeReason.startsWith('[受限内容已省略')) {
        return { ok: false, reason: '审批原因含受限内容，已拒绝该原因' }
      }
    }
    if (!approved && (!safeReason || safeReason.trim().length === 0)) {
      return { ok: false, reason: '拒绝审批必须提供非空原因' }
    }
    token.status = approved ? 'approved' : 'rejected'
    token.decidedAt = Date.now()
    if (safeReason) token.reason = safeReason
    return { ok: true, token }
  }

  /**
   * Runtime-internal: consume an approval token before executing a write.
   * Default-deny: every check must pass. On success the token flips to `used`
   * (single-use). On any failure the token stays in its failing status (or
   * is marked expired/cancelled) and the run gets a safe reason — NO execution.
   *
   * `match` is the re-computed request at execution time (the runtime rebuilds
   * it from the same validated input + target). Hash/scope/revision/input must
   * all match what was originally proposed.
   */
  consume(tokenId: string, match: AiApprovalRequest): AiConsumeResult {
    const token = this.tokens.get(tokenId)
    if (!token) {
      return { ok: false, reason: '审批令牌不存在', status: 'rejected' }
    }
    // Expiry check first — an expired token can never execute, regardless of
    // prior status (even an approved token expires after TTL).
    if (Date.now() > token.expiresAt) {
      token.status = 'expired'
      return { ok: false, reason: '审批已过期', status: 'expired' }
    }
    if (token.status === 'used') {
      return { ok: false, reason: '审批令牌已使用（单次有效）', status: 'used' }
    }
    if (token.status === 'cancelled') {
      return { ok: false, reason: '审批已取消', status: 'cancelled' }
    }
    if (token.status === 'rejected') {
      return { ok: false, reason: token.reason ?? '用户拒绝执行', status: 'rejected' }
    }
    if (token.status === 'expired') {
      return { ok: false, reason: '审批已过期', status: 'expired' }
    }
    if (token.status !== 'approved') {
      // pending or any unexpected status → deny
      return { ok: false, reason: '审批未通过', status: token.status }
    }
    // Bound checks: the token must match the execution request exactly.
    if (token.request.runId !== match.runId) {
      return { ok: false, reason: '审批绑定的运行不匹配', status: 'rejected' }
    }
    if (token.request.toolCallId !== match.toolCallId) {
      return { ok: false, reason: '审批绑定的工具调用不匹配', status: 'rejected' }
    }
    if (token.request.toolId !== match.toolId) {
      return { ok: false, reason: '审批绑定的工具不匹配', status: 'rejected' }
    }
    if (token.request.normalizedInput !== match.normalizedInput) {
      return { ok: false, reason: '审批绑定的输入不匹配', status: 'rejected' }
    }
    if (token.request.targetScope !== match.targetScope) {
      return { ok: false, reason: '审批绑定的目标范围不匹配', status: 'rejected' }
    }
    if (token.request.contentHash !== match.contentHash) {
      return { ok: false, reason: '内容哈希不匹配（提案已被篡改）', status: 'rejected' }
    }
    if (token.request.revision !== match.revision) {
      return { ok: false, reason: '目标快照已变更（过期提案）', status: 'rejected' }
    }
    // All checks passed — single-use: flip to used.
    token.status = 'used'
    return { ok: true }
  }

  /** Cancel all pending tokens for a run (cancel/terminal path). */
  cancel(runId: string): void {
    for (const token of this.tokens.values()) {
      if (token.request.runId === runId && token.status === 'pending') {
        token.status = 'cancelled'
        token.decidedAt = Date.now()
      }
    }
  }

  /** Cancel everything (quit path). */
  cancelAll(): void {
    for (const token of this.tokens.values()) {
      if (token.status === 'pending') {
        token.status = 'cancelled'
        token.decidedAt = Date.now()
      }
    }
  }

  listPending(): AiApprovalToken[] {
    this.purgeExpired()
    return [...this.tokens.values()]
      .filter((t) => t.status === 'pending')
      .map((t) => ({ ...t }))
  }

  /**
   * Typed read-only inspection of a token. Used by the runtime's
   * awaitApprovalDecision poller instead of reaching into private state.
   * Returns a safe snapshot (status + reason + expiresAt) or null if the token
   * does not exist. NEVER returns the request's normalizedInput/contentHash
   * (those stay runtime-internal; the runtime rebuilds them from the validated
   * input at consume time). The renderer gets the token via listPending/
   * approval-required event; this method is for the runtime's own poller.
   */
  inspect(tokenId: string): {
    status: AiApprovalStatus
    reason?: string
    expiresAt: number
  } | null {
    const token = this.tokens.get(tokenId)
    if (!token) return null
    return {
      status: token.status,
      reason: token.reason,
      expiresAt: token.expiresAt,
    }
  }

  /** Lazy-purge expired pending tokens (housekeeping on list/read). */
  purgeExpired(): void {
    const now = Date.now()
    for (const token of this.tokens.values()) {
      if (token.status === 'pending' && now > token.expiresAt) {
        token.status = 'expired'
      }
    }
  }
}

/**
 * sha256 hex of a string. Used for contentHash (what will be written) and
 * revision (source/target snapshot). Deterministic + collision-resistant.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Canonical JSON for deterministic comparison. Keys sorted, no whitespace.
 * Used for normalizedInput so two structurally-equal inputs compare equal
 * regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return sorted
  }
  return value
}
