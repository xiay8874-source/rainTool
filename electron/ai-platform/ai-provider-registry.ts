// Provider registry + protocol-aware stream adapter.
//
// Wraps @ai-sdk/openai so the Agent runtime (P3+) and the chat runtime (P1)
// never call a provider SDK directly. The registry resolves an AiModelProfile
// + raw key into a LanguageModelV2, and `streamChat` turns that into the
// text-delta stream the renderer consumes.
//
// P0-1: streamChat now routes by the profile's effective protocol:
//   - `openai-chat`        → @ai-sdk/openai `provider.chat(model)` + streamText
//                             (POST {baseUrl}/chat/completions). The legacy
//                             default; covers Ollama + OpenRouter + TokenHub.
//   - `openai-responses`   → @ai-sdk/openai `provider.responses(model)` +
//                             streamText (POST {baseUrl}/responses).
//   - `anthropic-messages` → raw fetch SSE streamer against
//                             {baseUrl}/v1/messages. @ai-sdk/anthropic is NOT
//                             installed (avoiding a new dep), so this path
//                             parses Anthropic's SSE directly and emits the
//                             same text-delta events. Bounded by the same
//                             per-call timeout + abort signal as the SDK path.
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
  type AiProtocol,
  type AiProviderId,
  type AiRunEvent,
} from './ai-types.js'

const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'

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
    // P0-1: route by effective protocol. openai-responses uses the Responses
    // API model; openai-chat (and the legacy default) use the Chat Completions
    // model. anthropic-messages does NOT go through resolveModel at all —
    // streamChat handles it via a raw fetch path (no @ai-sdk/anthropic dep).
    const protocol = this.effectiveProtocol(profile)
    if (protocol === 'openai-responses') {
      return provider.responses(profile.model)
    }
    return provider.chat(profile.model)
  }

  /**
   * P0-1: resolve the effective protocol for a profile. Per-model override
   * wins; otherwise the providerId default (anthropic → anthropic-messages,
   * everything else → openai-chat).
   */
  effectiveProtocol(profile: AiModelProfile): AiProtocol {
    if (profile.protocol) return profile.protocol
    return profile.providerId === 'anthropic' ? 'anthropic-messages' : 'openai-chat'
  }

  /**
   * One-shot non-streaming completion for short structured/summary requests.
   * Some OpenAI-compatible reasoning gateways occasionally finish an SSE
   * stream with reasoning chunks but no text delta, while their ordinary
   * completion response still contains `message.content`. Commit-title
   * generation uses this as a bounded fallback after an empty/invalid stream.
   */
  async completeChat(options: {
    profile: AiModelProfile
    apiKey: string
    messages: AiMessage[]
    system?: string
    abortSignal: AbortSignal
    timeoutMs?: number
  }): Promise<AiStreamOutcome> {
    const { profile, apiKey, messages, system, abortSignal } = options
    if (this.effectiveProtocol(profile) !== 'openai-chat') {
      return this.streamChat({
        profile,
        apiKey,
        messages,
        system,
        abortSignal,
        timeoutMs: options.timeoutMs,
        emit: () => {},
        runId: `complete-${Date.now()}`,
        sequence: { value: 0 },
      })
    }

    const timeoutController = new AbortController()
    const timeoutTimer = setTimeout(
      () => timeoutController.abort(),
      options.timeoutMs ?? AI_PER_CALL_TIMEOUT_MS,
    )
    const combined = AbortSignal.any([abortSignal, timeoutController.signal])
    const base = this.baseURLFor(profile).replace(/\/+$/, '')
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
    try {
      const response = await this.defaultFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey || 'raintool-no-key'}`,
        },
        body: JSON.stringify({
          model: profile.model,
          stream: false,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            ...messages
              .filter((message) => message.role !== 'tool')
              .map((message) => ({ role: message.role, content: message.text })),
          ],
        }),
        signal: combined,
      })
      if (!response.ok) {
        return { kind: 'failed', redactedError: `Provider HTTP ${response.status}` }
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const rawContent = payload.choices?.[0]?.message?.content
      const finalText = typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent
            .map((part) => part && typeof part === 'object' && 'text' in part
              ? String((part as { text: unknown }).text)
              : '')
            .join('')
          : ''
      return { kind: 'completed', finalText }
    } catch (error) {
      if (combined.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return {
          kind: 'aborted',
          partialText: '',
          reason: timeoutController.signal.aborted ? 'timeout' : 'cancel',
        }
      }
      return { kind: 'failed', redactedError: this.sanitizeError(error) }
    } finally {
      clearTimeout(timeoutTimer)
    }
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

    // P0-1: anthropic-messages uses a raw fetch SSE streamer (no SDK dep).
    if (this.effectiveProtocol(profile) === 'anthropic-messages') {
      return this.streamAnthropic({
        profile, apiKey, messages, system, abortSignal, emit, runId, sequence,
        timeoutMs, fetchImpl,
      })
    }

    // openai-chat / openai-responses: build a model via @ai-sdk/openai.
    let model: LanguageModelV2
    try {
      const provider = createOpenAI({
        baseURL: this.baseURLFor(profile),
        apiKey: apiKey || 'raintool-no-key',
        name: this.providerName(profile),
        fetch: fetchImpl,
      })
      model = this.effectiveProtocol(profile) === 'openai-responses'
        ? provider.responses(profile.model)
        : provider.chat(profile.model)
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

  /**
   * P0-1: Anthropic Messages API streamer (raw fetch + SSE). Used when the
   * profile's effective protocol is `anthropic-messages` and @ai-sdk/anthropic
   * is not installed. Emits the SAME text-delta events as the SDK path and
   * returns the same AiStreamOutcome shape, so the runtime owns the single
   * terminal exactly as it does for OpenAI.
   *
   * SSE events honored: `content_block_delta` (delta.type === 'text_delta' →
   * emit text-delta), `message_stop` → completed, `error` → failed. Other
   * events (message_start, content_block_start/stop, message_delta) are
   * ignored — we only need the text deltas + terminal signal.
   *
   * The raw key is sent only in the `x-api-key` header; it never appears in
   * emitted events or in the sanitized error. Errors are HTTP-non-2xx →
   * failed; abort/timeout → aborted (same reason-resolution as the SDK path).
   */
  private async streamAnthropic(opts: {
    profile: AiModelProfile
    apiKey: string
    messages: AiMessage[]
    system?: string
    abortSignal: AbortSignal
    emit: (event: AiRunEvent) => void
    runId: string
    sequence: { value: number }
    timeoutMs: number
    fetchImpl: AiFetch
  }): Promise<AiStreamOutcome> {
    const { profile, apiKey, messages, system, abortSignal, emit, runId, sequence, timeoutMs, fetchImpl } = opts
    const url = this.anthropicMessagesUrl(profile)
    const timeoutController = new AbortController()
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs)
    const combined = AbortSignal.any([abortSignal, timeoutController.signal])
    const abortedOutcome = (partialText: string): AiStreamOutcome => ({
      kind: 'aborted',
      partialText,
      reason: timeoutController.signal.aborted ? 'timeout' : 'cancel',
    })

    // Anthropic wants messages without 'system' role in the array; system goes
    // in a top-level field. Filter tool messages (P1 has none) + map roles.
    const sdkMessages = messages
      .filter((m) => m.role !== 'tool' && m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text }))

    let finalText = ''
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: combined,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey || 'raintool-no-key',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: profile.model,
          max_tokens: 4096,
          ...(system ? { system } : {}),
          messages: sdkMessages,
          stream: true,
        }),
      })
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '')
        return { kind: 'failed', redactedError: this.sanitizeError(`HTTP ${response.status} ${text.slice(0, 200)}`) }
      }
      // Parse SSE: split on blank lines into events; each event has `event:`
      // and `data:` lines. We only care about `data: {...}` JSON payloads.
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawStop = false
      while (true) {
        if (abortSignal.aborted || timeoutController.signal.aborted) {
          return abortedOutcome(finalText)
        }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE events are separated by `\n\n`.
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const dataLine = rawEvent
            .split('\n')
            .find((l) => l.startsWith('data:'))
          if (!dataLine) continue
          const jsonStr = dataLine.slice(5).trim()
          if (!jsonStr || jsonStr === '[DONE]') continue
          let payload: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } }
          try {
            payload = JSON.parse(jsonStr)
          } catch {
            continue
          }
          if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string') {
            finalText += payload.delta.text
            emit({
              runId,
              sequence: sequence.value++,
              type: 'text-delta',
              at: Date.now(),
              payload: { delta: payload.delta.text },
            })
          } else if (payload.type === 'message_stop') {
            sawStop = true
          } else if (payload.type === 'error') {
            return { kind: 'failed', redactedError: this.sanitizeError(payload.error?.message ?? 'Anthropic 流式错误') }
          }
        }
      }
      if (abortSignal.aborted || timeoutController.signal.aborted) {
        return abortedOutcome(finalText)
      }
      if (!sawStop) {
        // Stream ended without an explicit message_stop — treat as completed if
        // we got text, else failed (bounded + diagnosable, not a hang).
        return finalText
          ? { kind: 'completed', finalText }
          : { kind: 'failed', redactedError: 'Anthropic 流未返回内容' }
      }
      return { kind: 'completed', finalText }
    } catch (error) {
      if (abortSignal.aborted || timeoutController.signal.aborted
          || (error instanceof Error && error.name === 'AbortError')) {
        return abortedOutcome(finalText)
      }
      return { kind: 'failed', redactedError: this.sanitizeError(error) }
    } finally {
      clearTimeout(timeoutTimer)
    }
  }

  /** Anthropic Messages endpoint: {baseUrl}/v1/messages (normalize the path). */
  private anthropicMessagesUrl(profile: AiModelProfile): string {
    const base = (profile.baseUrl || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '')
    if (base.endsWith('/v1')) return `${base}/messages`
    if (base.endsWith('/messages')) return base
    return `${base}/v1/messages`
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
