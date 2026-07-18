// AI Platform shared types (DTOs, events, model profiles, run modes).
//
// These types cross the Electron IPC boundary: every field here is
// JSON-serializable and is what the renderer sees. Raw API keys, file paths
// beyond an opaque contentRef, and unredacted tool errors must never appear
// in these types. See docs/ai-platform-plan.md §3.3 and §4.3.

import type { AiDirectToolCall, AiToolRunEvent } from './ai-tool-types.js'
export type { AiDirectToolCall, AiToolRunEvent } from './ai-tool-types.js'

/** Run mode. P1 implements `chat` only; `assistant`/`agent` are reserved. */
export type AiRunMode = 'chat' | 'assistant' | 'agent'

/** Tool risk. P1 exposes NO tools; this is reserved for P3+. */
export type AiToolRisk = 'read' | 'propose' | 'write' | 'dangerous'

/** Provider kind. P1 ships OpenAI-compatible (covers Ollama + OpenRouter). */
export type AiProviderId = 'openai-compatible' | 'ollama' | 'anthropic' | 'google'

/** Attachment sensitivity. P1 has no attachments; reserved for P2. */
export type AiSensitivity = 'normal' | 'redacted' | 'restricted'

/** Attachment persistence mode. P1 has no attachments; reserved for P2. */
export type AiPersistMode = 'metadata-only' | 'encrypted-content' | 'ephemeral'

/** Conversation message role. */
export type AiMessageRole = 'user' | 'assistant' | 'system' | 'tool'

/**
 * Model Profile. Stored in the Model Profile repository. The `apiKey` is
 * NEVER persisted here; it lives only in the encrypted Credential Vault keyed
 * by `credentialKey`. The renderer receives profiles without any key.
 */
export interface AiModelProfile {
  id: string
  providerId: AiProviderId
  displayName: string
  model: string
  /** Base URL override. For Ollama this is `http://127.0.0.1:11434/v1`. */
  baseUrl?: string
  /** Credential vault key; never sent to renderer. */
  credentialKey: string
  capabilities: {
    vision: boolean
    toolCalling: boolean
    jsonSchema: boolean
    reasoning: boolean
  }
  maxInputTokens?: number
  createdAt: number
  updatedAt: number
}

/**
 * Masked credential status returned to the renderer. Never includes the raw
 * key, a hash that could be reversed, or enough characters to reconstruct it.
 */
export interface AiCredentialStatus {
  credentialKey: string
  configured: boolean
  /** First and last 2 chars only when configured; `undefined` otherwise. */
  maskedPreview?: string
  /** safeStorage encryption available on this machine. */
  encryptionAvailable: boolean
}

/**
 * Conversation message. Persisted in the conversation repository. `text` is
 * the only content stored; no raw keys, no ephemeral attachments (P2+).
 */
export interface AiMessage {
  id: string
  role: AiMessageRole
  at: number
  text: string
  /** Profile id actually used for assistant messages; recorded for audit. */
  modelProfileId?: string
  /** Run that produced this assistant message; `undefined` for user messages. */
  runId?: string
}

/** Persisted conversation. schemaVersion enables forward migration. */
export interface AiConversation {
  schemaVersion: number
  id: string
  title: string
  modelProfileId: string
  mode: AiRunMode
  createdAt: number
  updatedAt: number
  messages: AiMessage[]
  /** Summaries of runs for the audit log; no keys, no full payloads. */
  runAuditRefs: AiRunAuditRef[]
}

export interface AiRunAuditRef {
  runId: string
  startedAt: number
  endedAt?: number
  modelProfileId: string
  status: 'completed' | 'failed' | 'cancelled'
  redactedError?: string
}

/** Conversation list item (no messages, for the sidebar). */
export interface AiConversationSummary {
  id: string
  title: string
  modelProfileId: string
  mode: AiRunMode
  createdAt: number
  updatedAt: number
  messageCount: number
}

/** Run event types emitted on the `ai:run:event` channel. */
export type AiRunEventType =
  | 'started'
  | 'text-delta'
  | 'completed'
  | 'failed'
  | 'cancelled'
  // P3 tool + approval + apply events (non-terminal; runtime still owns
  // exactly-one terminal via commitTerminal). See ai-tool-types.ts for payloads.
  | 'tool-call-proposed'
  | 'approval-required'
  | 'approval-resolved'
  | 'tool-started'
  | 'tool-completed'
  | 'tool-failed'
  | 'apply-request'

export type AiRunEvent =
  | { runId: string; sequence: number; type: 'started'; at: number; payload: { conversationId: string; modelProfileId: string; mode: AiRunMode } }
  | { runId: string; sequence: number; type: 'text-delta'; at: number; payload: { delta: string } }
  | { runId: string; sequence: number; type: 'completed'; at: number; payload: { finalText: string } }
  | { runId: string; sequence: number; type: 'failed'; at: number; payload: { redactedError: string; kind: 'provider' | 'internal' } }
  | { runId: string; sequence: number; type: 'cancelled'; at: number; payload: { reason: AiCancelReason; partialText: string } }
  // P3 tool + approval events. Re-exported from ai-tool-types for ergonomics;
  // defined there so the tool module owns its own contract. These variants
  // carry the same { runId, sequence, type, at, payload } envelope.
  | AiToolRunEvent

/**
 * Inbound start-run request from the renderer. No keys, no tools in P1.
 *
 * P2 adds `attachmentIds`: the explicit, user-selected attachments to include
 * as model context. ONLY ids listed here are sent — the runtime never pulls in
 * component context silently. Unknown/invalid ids are rejected at the IPC
 * boundary before the run starts. Restricted attachments block the run
 * fail-closed (see ai-context-budget).
 */
export interface AiStartRunRequest {
  conversationId: string
  modelProfileId: string
  mode: AiRunMode
  message: string
  /** P2: explicit attachment ids to include as model context (no silent context). */
  attachmentIds?: string[]
  /**
   * P3: explicit, renderer/test-requested tool calls (direct invocation). The
   * runtime resolves + Zod-validates each via the registry, then runs the tool
   * state machine. The model is NEVER given tools — this is not model tool
   * calling. When `toolCalls` is present and non-empty, the run executes the
   * tools (no model stream). When absent/empty, the run is a normal chat.
   */
  toolCalls?: AiDirectToolCall[]
}

/**
 * Why a run was cancelled.
 *   - `user`: explicit renderer cancel (Stop button) or a new run preempting.
 *   - `timeout`: total-run (10min) OR per-call (120s) budget exceeded.
 *   - `window-closed`: app shutdown / window closed (cancelAll path).
 */
export type AiCancelReason = 'user' | 'timeout' | 'window-closed'

/** Result of creating/updating a credential. Never echoes the key back. */
export type AiSaveCredentialResult =
  | { ok: true; status: AiCredentialStatus }
  | { ok: false; reason: 'encryption-unavailable' }

/**
 * Input for creating/updating a model profile. Lives in ai-types because it
 * crosses the IPC boundary (renderer → main). The repository re-exports it.
 * `credentialKey` references the encrypted vault; no raw key here.
 */
export interface AiProfileInput {
  id?: string
  providerId: AiProviderId
  displayName: string
  model: string
  baseUrl?: string
  credentialKey: string
  capabilities?: Partial<AiModelProfile['capabilities']>
  maxInputTokens?: number
}

/** Constants. */
export const AI_CONVERSATION_SCHEMA_VERSION = 1
export const AI_PROFILE_SCHEMA_VERSION = 1
/** P1 default guardrails (plan §4.2). */
export const AI_MAX_RUN_STEPS = 8
export const AI_MAX_RUN_MS = 10 * 60 * 1000
export const AI_PER_CALL_TIMEOUT_MS = 120_000

/**
 * Run modes the P1 main-process boundary actually implements. The `AiRunMode`
 * union keeps `assistant`/`agent` for forward compatibility, but P1 ships no
 * agent loop, tool-calling, or component writeback — the runtime rejects
 * non-`chat` start requests with an explicit safe error so the UI never
 * silently enters an unimplemented mode. P3+ widens this set.
 */
export const P1_SUPPORTED_RUN_MODES: ReadonlySet<AiRunMode> = new Set(['chat'])
