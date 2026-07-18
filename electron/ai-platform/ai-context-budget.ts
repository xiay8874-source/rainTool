// P2 context budget gate — pure module (no `electron` import).
//
// Enforces a bounded token/byte budget on attachments BEFORE the provider call.
// Only explicitly-selected, permitted attachments become model context; no
// silent component context. Restricted attachments block the run fail-closed.
//
// Deterministic token estimate: `max(1, Math.ceil(utf8Bytes / 4))`. This is a
// deliberate, stable approximation (not tied to any provider tokenizer) so the
// UI chip, the audit, and the gate all agree and the result is reproducible
// across runs. The per-attachment cap and the total budget are constants in
// ai-context-types.ts.

import {
  AI_CONTEXT_BUDGET_BYTES,
  AI_CONTEXT_BUDGET_TOKENS,
  AI_CONTEXT_MAX_ATTACHMENT_BYTES,
  AI_CONTEXT_MAX_ATTACHMENT_TOKENS,
  type AiAttachmentBudgetStatus,
  type AiAttachmentBudgetView,
  type AiAttachmentMeta,
  type AiContextGateResult,
} from './ai-context-types.js'

/** Deterministic token estimate for a text blob (utf-8 bytes / 4, min 1). */
export function estimateTokens(text: string): number {
  const bytes = utf8ByteLength(text)
  return Math.max(1, Math.ceil(bytes / 4))
}

/** UTF-8 byte length without depending on Node Buffer (renderer-safe). */
export function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length
  }
  // Fallback for environments without TextEncoder (should not occur in P2).
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

export interface AiContextAttachment {
  meta: AiAttachmentMeta
  /** Raw payload (only for included, non-restricted attachments). */
  text: string
}

/**
 * Gate a set of selected attachments against the budget. The caller passes the
 * attachment metas + payloads in SELECTION ORDER (the order the user picked
 * them); earlier attachments win the budget. Returns the assembled context
 * text, per-attachment views for the UI, and a fail-closed `blocked` flag.
 *
 * Rules:
 *   - Unknown id (no meta): rejected-unknown (not included).
 *   - Restricted: rejected-restricted AND `blocked=true` (whole run fails).
 *   - Oversize (exceeds per-attachment cap): rejected-oversize (not included).
 *   - Within per-attachment cap but total budget exceeded: truncated to fit.
 *   - Otherwise: ok, included with its full text.
 */
export function gateContext(
  attachments: AiContextAttachment[],
): AiContextGateResult {
  const views: AiAttachmentBudgetView[] = []
  let totalTokens = 0
  let totalBytes = 0
  let blocked = false
  let blockReason: string | undefined

  // First pass: classify each attachment. A restricted attachment sets the
  // fail-closed block; we still build views for all so the UI can show why.
  for (const { meta, text } of attachments) {
    if (meta.sensitivity === 'restricted') {
      views.push({
        id: meta.id,
        title: meta.title,
        byteSize: meta.byteSize,
        tokenEstimate: meta.tokenEstimate,
        sensitivity: meta.sensitivity,
        included: false,
        status: 'rejected-restricted',
        contributedTokens: 0,
        restrictionReason: meta.restrictionReason,
      })
      if (!blocked) {
        blocked = true
        blockReason = meta.restrictionReason ?? '附件含受限内容，已阻止发送'
      }
      continue
    }
    // Oversize: exceeds per-attachment cap.
    if (meta.byteSize > AI_CONTEXT_MAX_ATTACHMENT_BYTES
        || meta.tokenEstimate > AI_CONTEXT_MAX_ATTACHMENT_TOKENS) {
      views.push({
        id: meta.id,
        title: meta.title,
        byteSize: meta.byteSize,
        tokenEstimate: meta.tokenEstimate,
        sensitivity: meta.sensitivity,
        included: false,
        status: 'rejected-oversize',
        contributedTokens: 0,
      })
      continue
    }
    // Within budget so far?
    const remainingTokens = AI_CONTEXT_BUDGET_TOKENS - totalTokens
    const remainingBytes = AI_CONTEXT_BUDGET_BYTES - totalBytes
    if (meta.tokenEstimate <= remainingTokens && meta.byteSize <= remainingBytes) {
      views.push({
        id: meta.id,
        title: meta.title,
        byteSize: meta.byteSize,
        tokenEstimate: meta.tokenEstimate,
        sensitivity: meta.sensitivity,
        included: true,
        status: 'ok',
        contributedTokens: meta.tokenEstimate,
      })
      totalTokens += meta.tokenEstimate
      totalBytes += meta.byteSize
    } else {
      // Truncate to fit the remaining token budget (deterministic: cut by
      // bytes, re-estimate). A truncated attachment is still included.
      const allowedBytes = Math.min(
        remainingBytes,
        remainingTokens * 4,
        AI_CONTEXT_MAX_ATTACHMENT_BYTES,
      )
      if (allowedBytes <= 0) {
        views.push({
          id: meta.id,
          title: meta.title,
          byteSize: meta.byteSize,
          tokenEstimate: meta.tokenEstimate,
          sensitivity: meta.sensitivity,
          included: false,
          status: 'rejected-oversize',
          contributedTokens: 0,
        })
        continue
      }
      const truncated = truncateToBytes(text, allowedBytes)
      const truncTokens = estimateTokens(truncated)
      views.push({
        id: meta.id,
        title: meta.title,
        byteSize: utf8ByteLength(truncated),
        tokenEstimate: truncTokens,
        sensitivity: meta.sensitivity,
        included: true,
        status: 'truncated',
        contributedTokens: truncTokens,
      })
      totalTokens += truncTokens
      totalBytes += utf8ByteLength(truncated)
    }
  }

  // Assemble context text from included attachments in order.
  const contextText = assembleContext(attachments, views)
  return { contextText, views, totalTokens, totalBytes, blocked, blockReason }
}

/** Assemble the final context string prepended to the provider call. */
function assembleContext(
  attachments: AiContextAttachment[],
  views: AiAttachmentBudgetView[],
): string {
  const included = views.filter((v) => v.included)
  if (included.length === 0) return ''
  const byId = new Map(attachments.map((a) => [a.meta.id, a.text]))
  const parts: string[] = ['[附加上下文]']
  for (const v of included) {
    const text = byId.get(v.id) ?? ''
    const label = v.status === 'truncated' ? `${v.title} (已截断)` : v.title
    parts.push(`--- ${label} ---`)
    parts.push(v.status === 'truncated' ? truncateToBytes(text, v.byteSize) : text)
  }
  parts.push('[附加结束]')
  return parts.join('\n')
}

/** Truncate text to at most `maxBytes` UTF-8 bytes on a code-point boundary. */
function truncateToBytes(text: string, maxBytes: number): string {
  const bytes = utf8ByteLength(text)
  if (bytes <= maxBytes) return text
  // Greedy append by code points until we exceed the budget.
  let result = ''
  let used = 0
  for (const ch of text) {
    const chBytes = utf8ByteLength(ch)
    if (used + chBytes > maxBytes) break
    result += ch
    used += chBytes
  }
  return result
}
