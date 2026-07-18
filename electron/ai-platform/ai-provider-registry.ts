// Provider registry + OpenAI-compatible stream adapter.
//
// Wraps @ai-sdk/openai so the Agent runtime (P3+) and the chat runtime (P1)
// never call a provider SDK directly. The registry resolves an AiModelProfile
// + raw key into a LanguageModelV2, and `streamChat` turns that into the
// text-delta stream the renderer consumes.
//
// P1 scope: chat only (no tools, no structured output). Ollama is supported
// via the OpenAI-compatible endpoint at http://127.0.0.1:11434/v1. Anthropic
// and Google are reserved (not installed — plan §4.1 ships them later).
//
// The injected `fetch` option lets tests point at a mock local endpoint
// without monkeypatching global fetch.
//
// Terminal-event contract: streamChat emits ONLY `text-delta` events and
// returns an explicit AiStreamOutcome. It NEVER emits a terminal
// (`completed`/`failed`/`cancelled`) — the RUNTIME owns the single terminal so
// it can persist the assistant reply BEFORE committing `completed`. This
// prevents the renderer from reloading a stale conversation on completion and
// guarantees exactly one terminal per run.

import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import type { LanguageModelV2 } from '@ai-sdk/provider'
import {
  AI_PER_CALL_TIMEOUT_MS,
  type AiMessage,
  type AiModelProfile,
  type AiProviderId,
  type AiRunEvent,
} from './ai-types.js'

const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** A custom fetch for routing requests to a mock in tests. */
export type AiFetch = typeof fetch

/**
 * Explicit terminal outcome from streamChat. streamChat emits ONLY text-delta
 * events; the runtime uses the returned outcome to own the single terminal:
 *   - `completed`: runtime persists the assistant reply, THEN emits `completed`.
 *   - `failed`: runtime emits a single `failed` terminal; persists nothing.
 *   - `aborted`: runtime emits a single `cancelled` terminal.
 *     `reason` distinguishes the provider's own per-call timeout from a
 *     runtime-initiated cancel (user/timeout/window-closed), so the runtime
 *     reports the correct cancel reason in the `cancelled` event.
 */
export type AiStreamOutcome =
  | { kind: 'completed'; finalText: string }
  | { kind: 'failed'; redactedError: string }
  | { kind: 'aborted'; partialText: string; reason: 'timeout' | 'cancel' }

export interface AiProviderRuntime {
  /** Resolve a profile + key into a language model. Throws on misconfiguration. */
  resolveModel(profile: AiModelProfile, apiKey: string): LanguageModelV2
  /** Provider display id for audit events. */
  providerId(profile: AiModelProfile): string
}

export interface AiStreamChatOptions {
  profile: AiModelProfile
  apiKey: string
  messages: AiMessage[]
  /** System prompt prepended to the conversation; never carries user data. */
  system?: string
  /** Per-call abort signal from the runtime; cancels the fetch + stream. */
  abortSignal: AbortSignal
  /** Per-call hard timeout (ms). Defaults to AI_PER_CALL_TIMEOUT_MS. */
  timeoutMs?: number
  /** Injected fetch (tests route to a mock). Defaults to global fetch. */
  fetch?: AiFetch
  /** Emitter for run events; receives text-delta/completed/failed. */
  emit: (event: AiRunEvent) => void
  /** Run id + sequence seed for event ordering. */
  runId: string
  /** Next sequence number to use; mutated in place as events emit. */
  sequence: { value: number }
}

/**
 * Provider registry. P1 implements the OpenAI-compatible branch; Ollama reuses
 * it with a loopback base URL. The registry is the single point that turns a
 * profile into a LanguageModelV2, so P3+ tool-loop code stays provider-agnostic.
 */
export class AiProviderRegistry implements AiProviderRuntime {
  private readonly defaultFetch: AiFetch

  constructor(options: { fetch?: AiFetch } = {}) {
    this.defaultFetch = options.fetch ?? fetch
  }

  providerId(profile: AiModelProfile): string {
    return profile.providerId
  }

  resolveModel(profile: AiModelProfile, apiKey: string): LanguageModelV2 {
    const provider = createOpenAI({
      baseURL: this.baseURLFor(profile),
      apiKey: apiKey || 'raintool-no-key',
      name: this.providerName(profile),
      fetch: this.defaultFetch,
    })
    return provider.chat(profile.model)
  }

  /**
   * Stream a chat completion. Emits ONLY `text-delta` events as deltas arrive.
   * It NEVER emits a terminal event (`completed`/`failed`/`cancelled`) — it
   * returns an explicit AiStreamOutcome and the RUNTIME owns the single
   * terminal. This ordering guarantee lets the runtime persist the assistant
   * reply BEFORE emitting `completed`, so a renderer that reloads the
   * conversation on `completed` never sees stale state.
   *
   * Outcomes:
   *   - `completed`   — stream finished; `finalText` is the full reply.
   *   - `failed`      — stream errored; `redactedError` is sanitized (no key).
   *   - `aborted`     — stream was aborted (runtime cancel or per-call
   *                     timeout); `reason` distinguishes the two so the runtime
   *                     reports the correct cancel reason.
   *
   * The raw key never appears in any event OR log — only the SDK sees it, the
   * SDK's default error logger is suppressed (streamText `onError: () => {}`),
   * and errors are sanitized (redactSecrets) before reaching the outcome.
   */
  async streamChat(options: AiStreamChatOptions): Promise<AiStreamOutcome> {
    const {
      profile, apiKey, messages, system, abortSignal, emit, runId, sequence,
    } = options
    const timeoutMs = options.timeoutMs ?? AI_PER_CALL_TIMEOUT_MS
    const fetchImpl = options.fetch ?? this.defaultFetch

    let model: LanguageModelV2
    try {
      const provider = createOpenAI({
        baseURL: this.baseURLFor(profile),
        apiKey: apiKey || 'raintool-no-key',
        name: this.providerName(profile),
        fetch: fetchImpl,
      })
      model = provider.chat(profile.model)
    } catch (error) {
      // No terminal emitted; runtime owns the single `failed` from the outcome.
      return { kind: 'failed', redactedError: this.sanitizeError(error) }
    }

    // Combine the runtime's abort signal (user cancel / total-run timeout /
    // window-close) with a hard per-call timeout. The timeout has its OWN
    // controller so we can distinguish a per-call timeout from a runtime
    // cancel: after the stream ends we check which signal fired.
    const timeoutController = new AbortController()
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs)
    const combined = AbortSignal.any([abortSignal, timeoutController.signal])

    /** Distinguish this provider's per-call timeout from a runtime cancel. */
    const abortedOutcome = (partialText: string): AiStreamOutcome => ({
      kind: 'aborted',
      partialText,
      // If OUR per-call timeout fired, it's a timeout — regardless of whether
      // the runtime also aborted. Otherwise it's a runtime-initiated cancel
      // (user / total-run timeout / window-close), whose exact reason the
      // runtime resolves from its preserved cancelReason.
      reason: timeoutController.signal.aborted ? 'timeout' : 'cancel',
    })

    let finalText = ''
    try {
      // P1 scope: chat only — no tool messages. Skip any 'tool' role (should
      // not exist in P1, but guard anyway) and narrow to the SDK's accepted
      // literal roles so AiMessageRole (which includes 'tool') stays assignable
      // to ModelMessage.
      const sdkMessages = messages
        .filter((m) => m.role !== 'tool')
        .map((m) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.text,
        }))
      const result = streamText({
        model,
        system,
        messages: sdkMessages,
        abortSignal: combined,
        maxRetries: 0,
        // The SDK's default onError is `console.error(error)`, which prints the
        // full APICallError — including the request body/headers that carry the
        // raw `Authorization: Bearer sk-...` key — to stdout/stderr whenever
        // the stream errors (HTTP non-2xx, network failure, etc.). That would
        // leak the key to logs even though the outcome we RETURN is redacted.
        // Suppress the SDK's own logging here; we surface a sanitized error
        // exclusively via the `failed` outcome (see sanitizeError/redactSecrets).
        onError: () => {},
      })

      for await (const part of result.fullStream) {
        if (abortSignal.aborted || timeoutController.signal.aborted) {
          // Aborted: no terminal; runtime owns `cancelled`.
          return abortedOutcome(finalText)
        }
        if (part.type === 'text-delta') {
          finalText += part.text
          emit({
            runId,
            sequence: sequence.value++,
            type: 'text-delta',
            at: Date.now(),
            payload: { delta: part.text },
          })
        } else if (part.type === 'error') {
          // SDK stream error: return the failed outcome; runtime emits the
          // single `failed` terminal.
          return { kind: 'failed', redactedError: this.sanitizeError(part.error) }
        }
        // Other part types (start-step, finish-step, tool-*) are ignored in
        // P1: no tools are registered, so tool-* parts never appear.
      }

      if (abortSignal.aborted || timeoutController.signal.aborted) {
        return abortedOutcome(finalText)
      }
      return { kind: 'completed', finalText }
    } catch (error) {
      if (abortSignal.aborted || timeoutController.signal.aborted
          || (error instanceof Error && error.name === 'AbortError')) {
        // Aborted (runtime cancel or per-call timeout). No terminal from
        // provider; runtime emits `cancelled` with the resolved reason.
        return abortedOutcome(finalText)
      }
      return { kind: 'failed', redactedError: this.sanitizeError(error) }
    } finally {
      clearTimeout(timeoutTimer)
    }
  }

  private baseURLFor(profile: AiModelProfile): string {
    if (profile.baseUrl) return profile.baseUrl
    if (profile.providerId === 'ollama') return OLLAMA_DEFAULT_BASE_URL
    return OPENAI_DEFAULT_BASE_URL
  }

  private providerName(profile: AiModelProfile): string {
    return profile.providerId === 'ollama' ? 'ollama'
      : profile.providerId === 'openai-compatible' ? 'openai-compatible'
      : profile.providerId
  }


  /**
   * Strip anything that looks like a key, URL query, or Authorization header
   * from an error before it crosses to the renderer. The renderer only ever
   * sees a short, generic message.
   */
  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
    return redactSecrets(raw).slice(0, 300)
  }
}

/**
 * Redact anything resembling a secret from a string before it is shown to the
 * renderer or written to the audit log. Conservative: also strips bearer
 * tokens, long hex/base64 runs, and `sk-...` style keys.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-••••')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ••••')
    .replace(/authorization["'\s:]+[A-Za-z0-9._-]+/gi, 'authorization: ••••')
    .replace(/api[_-]?key["'\s:=]+[A-Za-z0-9._-]{8,}/gi, 'api_key: ••••')
    .replace(/[A-Za-z0-9_-]{40,}/g, (match) => (match.startsWith('sk-') ? match : '••••'))
    .slice(0, 500)
}

/** Reserved provider ids that P1 knows how to resolve. */
export const SUPPORTED_PROVIDERS: ReadonlySet<AiProviderId> = new Set([
  'openai-compatible',
  'ollama',
])
