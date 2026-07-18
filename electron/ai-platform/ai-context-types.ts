// P2 Context Vault + read-only Artifacts — shared types (DTOs).
//
// These types cross the Electron IPC boundary: every field is JSON-serializable
// and is what the renderer sees. The raw attachment PAYLOAD (full text) NEVER
// crosses IPC and is NEVER written into conversation JSON. Only opaque
// metadata (id, title, size, tokens, sensitivity, storage policy) is shared;
// the actual bytes live main-process side in the Context Vault (ephemeral by
// default) and are released to the provider ONLY for the active run, after
// budget + sensitivity gating.
//
// Artifacts are proposals only: there is NO apply/writeback action. The
// artifact repository stores metadata + revisions + content, but the UI
// exposes only preview/copy — never an action that writes back into an editor,
// a file, or the conversation.

/** Component that produced an attachment (provenance for the chip). */
export type AiAttachmentSource =
  | 'json-workbench'   // JSON Workbench: current input or a selection
  | 'ai-assistant'     // pasted/dropped into the AI Assistant directly
  | 'manual'           // explicitly attached by the user

/** Attachment sensitivity classification (set by the scanner). */
export type AiAttachmentSensitivity = 'normal' | 'restricted'

/**
 * Storage policy for an attachment's payload.
 *   - `ephemeral` (default): payload lives only in memory for the active
 *     run/session and is cleared on expiry/cancel/delete/quit. Never persisted.
 *   - `metadata-only`: only the metadata is persisted (the payload is still
 *     in-memory and cleared the same way); the persisted metadata lets the chip
 *     survive a reload as a placeholder that cannot be re-sent without the user
 *     re-attaching the content.
 */
export type AiAttachmentStorage = 'ephemeral' | 'metadata-only'

/** Artifact kind. Artifacts are read-only proposals; no writeback. */
export type AiArtifactKind = 'markdown' | 'json' | 'code'

/**
 * Opaque attachment metadata that crosses IPC. The raw payload is NEVER here.
 * `byteSize` and `tokenEstimate` are set by the vault at ingest (deterministic,
 * computed once). `sensitivity` is set by the scanner and is final — the UI
 * must not let the user downgrade a `restricted` attachment to send it.
 *
 * `payloadAvailable` is false for a metadata-only placeholder loaded after a
 * restart (the payload was ephemeral and is gone). Such a placeholder can be
 * listed and deleted, but cannot be sent — `getText` and `validateIds` reject
 * it, and the runtime skips it. The renderer shows it as an unavailable chip.
 */
export interface AiAttachmentMeta {
  id: string
  source: AiAttachmentSource
  title: string
  byteSize: number
  /** Deterministic token estimate (chars / 4, min 1). */
  tokenEstimate: number
  sensitivity: AiAttachmentSensitivity
  storage: AiAttachmentStorage
  createdAt: number
  /** Epoch ms when the ephemeral payload expires and is purged. */
  expiresAt: number
  /**
   * If sensitivity is `restricted`, a short, safe reason shown in the UI
   * (e.g. "检测到 .env 赋值"). Never contains the raw restricted text.
   */
  restrictionReason?: string
  /**
   * True iff the raw payload is currently in memory and available to send.
   * False for a metadata-only placeholder loaded after a restart (the ephemeral
   * payload is gone). The renderer shows such a chip as unavailable; the
   * runtime/vault reject it on send.
   */
  payloadAvailable: boolean
}

/**
 * Per-attachment budget view for the UI chip. Computed by the budget gate.
 * `included` is false when the attachment was truncated or rejected.
 */
export interface AiAttachmentBudgetView {
  id: string
  title: string
  byteSize: number
  tokenEstimate: number
  sensitivity: AiAttachmentSensitivity
  included: boolean
  /** 'ok' | 'truncated' | 'rejected-oversize' | 'rejected-restricted' | 'rejected-unknown' */
  status: AiAttachmentBudgetStatus
  /** Tokens contributed to the model context (0 if not included). */
  contributedTokens: number
  restrictionReason?: string
}

export type AiAttachmentBudgetStatus =
  | 'ok'
  | 'truncated'
  | 'rejected-oversize'
  | 'rejected-restricted'
  | 'rejected-unknown'

/**
 * Result of gating attachments against the budget before a provider call.
 * `contextText` is the assembled, sanitized model context (only included
 * attachments, in selection order). `blocked` runs fail-closed: if ANY
 * selected attachment is restricted, the whole run is blocked.
 */
export interface AiContextGateResult {
  /** Sanitized, assembled context text ready to prepend to the provider call. */
  contextText: string
  /** Per-attachment budget view for UI + audit. */
  views: AiAttachmentBudgetView[]
  /** Total tokens contributed by included attachments. */
  totalTokens: number
  /** Total bytes of included attachment payloads. */
  totalBytes: number
  /** True iff a restricted attachment blocked the run (fail-closed). */
  blocked: boolean
  /** Safe reason when blocked (no raw restricted text). */
  blockReason?: string
}

/** Input for creating an attachment (renderer → main). No id/expiresAt. */
export interface AiAttachmentInput {
  source: AiAttachmentSource
  title: string
  /** Raw payload text — stays main-process; never returned to renderer. */
  text: string
  storage?: AiAttachmentStorage
}

/** Artifact metadata (no content in list view). */
export interface AiArtifactMeta {
  id: string
  kind: AiArtifactKind
  title: string
  createdAt: number
  updatedAt: number
  /** Language hint for code artifacts; ignored for markdown/json. */
  language?: string
  /** Conversation that produced it (provenance). */
  conversationId?: string
  runId?: string
  revisionCount: number
}

/** Full artifact document including the current content for preview/copy. */
export interface AiArtifactDocument extends AiArtifactMeta {
  schemaVersion: number
  content: string
  revisions: AiArtifactRevision[]
}

export interface AiArtifactRevision {
  revision: number
  at: number
  byteSize: number
}

/** Input for creating/updating an artifact. */
export interface AiArtifactInput {
  kind: AiArtifactKind
  title: string
  content: string
  language?: string
  conversationId?: string
  runId?: string
}

/** Result of validating JSON artifact content. */
export interface AiArtifactJsonValidation {
  valid: boolean
  /** Safe error message (no raw content) when invalid. */
  error?: string
}

/** P2 budget constants (plan §4.2 extension). */
export const AI_CONTEXT_BUDGET_TOKENS = 8_000
export const AI_CONTEXT_BUDGET_BYTES = 64_000
export const AI_CONTEXT_MAX_ATTACHMENT_BYTES = 32_000
export const AI_CONTEXT_MAX_ATTACHMENT_TOKENS = 4_000
export const AI_CONTEXT_DEFAULT_TTL_MS = 30 * 60 * 1000
export const AI_CONTEXT_MAX_ATTACHMENTS_PER_RUN = 8
