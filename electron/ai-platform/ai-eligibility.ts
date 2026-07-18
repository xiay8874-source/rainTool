// Outbound privacy-gate eligibility (renderer + main-process shared).
//
// Pure module: no `electron` import, no Node-only API. Only the `URL` global
// (available in both the renderer and Node 20) and the `AiModelProfile` type.
// This lets the renderer bundle it (via vite) and node:test import the compiled
// `dist-electron/ai-platform/ai-eligibility.js` from a single source of truth.
//
// Privacy gate rule (plan §3.3, Gate P1):
//   A run may start only after the user has confirmed outbound data transfer
//   for the session — UNLESS the profile's effective base URL is loopback, in
//   which case no data leaves this machine and confirmation is not required.
//
// The exemption is decided by the EFFECTIVE URL, not the provider id:
//   - Ollama with its default `http://127.0.0.1:11434/v1` → exempt (local).
//   - Ollama with a remote `baseUrl` override → NOT exempt (must confirm).
//   - openai-compatible pointing at `http://localhost:1234/v1` (e.g. a local
//     LM Studio / llama.cpp server) → exempt.
//   - openai-compatible pointing at `https://api.openai.com/v1` → must confirm.
// The provider id is a routing hint; the URL is the truth about where the
// conversation text is sent. A LAN address (192.168.x.x) is NOT loopback and
// still requires confirmation — it leaves this machine.
//
// Confirmation is destination-bound: a confirmation authorizes ONE outbound
// destination. Switching to a different profile (when at least one side is
// remote) resets `privacyConfirmed` via `shouldResetConfirmation`, so a
// confirmation to one remote provider/URL never silently authorizes a
// different remote destination. See `shouldResetConfirmation`.

import type { AiModelProfile } from './ai-types.js'

const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The base URL a run will actually hit. Mirrors `AiProviderRegistry.baseURLFor`
 * so the gate decides on the same URL the provider dials. Kept here (not
 * imported from the registry) so this module stays free of SDK imports.
 */
export function effectiveBaseUrl(profile: AiModelProfile): string {
  if (profile.baseUrl) return profile.baseUrl
  return profile.providerId === 'ollama' ? OLLAMA_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL
}

/**
 * True iff the URL's host is loopback — the request stays on this machine.
 * Malformed URLs return false (fail-closed: require confirmation). IPv6
 * loopback is accepted in both bracketed (`[::1]`, as `URL.hostname` returns
 * it) and bare (`::1`) forms.
 */
export function isLoopbackBaseUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // `URL.hostname` returns `[::1]` (with brackets) for IPv6; normalize so the
  // loopback set can match both bracketed and bare forms.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(host)
}

/**
 * True iff runs against this profile do not send data off this machine.
 * Such profiles are exempt from the outbound-confirmation gate.
 */
export function isOutboundLocal(profile: AiModelProfile): boolean {
  return isLoopbackBaseUrl(effectiveBaseUrl(profile))
}

/** Minimal view of renderer/store state the gate needs. */
export interface AiEligibilityState {
  activeConversation: { id: string } | null
  activeProfile: AiModelProfile | null
  runStatus: 'idle' | 'streaming' | 'cancelling' | 'error'
  privacyConfirmed: boolean
  input: string
  /**
   * P2: the selected attachment chips for the next run. Each carries
   * `payloadAvailable` — false means the in-memory payload was lost (e.g. after
   * a restart) and the id is no longer sendable. The gate blocks fail-closed
   * when any selected chip is unavailable, so the runtime never receives an id
   * it would have to reject (and the UI never silently drops a chip).
   */
  attachments?: { payloadAvailable: boolean }[]
}

export type AiEligibilityResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'no-conversation'
        | 'no-profile'
        | 'streaming'
        | 'empty'
        | 'needs-confirmation'
        | 'unavailable-attachments'
      /** Short Chinese message safe to show in the UI as the disabled reason. */
      message: string
    }

/**
 * Decide whether a run may start now, and if not, why. The renderer uses this
 * for `canSend` (button + Enter) and the store re-checks it in `startRun` as
 * defense-in-depth. Ordering of checks is stable so the UI shows the most
 * actionable reason first (missing config before confirmation before input).
 *
 * P2: the unavailable-attachments check runs LAST (after the privacy gate). A
 * chip whose payload was lost (payloadAvailable:false, e.g. after a restart)
 * cannot be sent — the runtime's vault would reject the id, so the gate blocks
 * fail-closed up front with a clear reason instead of letting the run start and
 * fail mid-flight. The user must remove or re-attach the unavailable chip.
 */
export function eligibilityReason(state: AiEligibilityState): AiEligibilityResult {
  if (!state.activeConversation) {
    return { ok: false, reason: 'no-conversation', message: '请先选择或新建会话' }
  }
  if (!state.activeProfile) {
    return { ok: false, reason: 'no-profile', message: '请先配置模型' }
  }
  if (state.runStatus === 'streaming' || state.runStatus === 'cancelling') {
    return { ok: false, reason: 'streaming', message: '生成中，请先停止' }
  }
  if (!state.input.trim()) {
    return { ok: false, reason: 'empty', message: '请输入消息' }
  }
  // Loopback profiles (local Ollama / local LM Studio) never leave this machine
  // and are exempt from the outbound-confirmation gate.
  if (!isOutboundLocal(state.activeProfile) && !state.privacyConfirmed) {
    return {
      ok: false,
      reason: 'needs-confirmation',
      message: '首次发送需确认出网（本地模型除外）',
    }
  }
  // P2: fail-closed on unavailable attachment chips. The payload is gone (e.g.
  // after a restart); the runtime would reject the id, so block here with a
  // clear reason. No silent ignore — the user must remove or re-attach.
  if (state.attachments && state.attachments.some((a) => !a.payloadAvailable)) {
    return {
      ok: false,
      reason: 'unavailable-attachments',
      message: '含失效附件，请移除或重新附加后再发送',
    }
  }
  return { ok: true }
}

/** Convenience: true iff a run may start now. */
export function canStartRun(state: AiEligibilityState): boolean {
  return eligibilityReason(state).ok
}

/**
 * Decide whether switching/updating from `prev` to `next` profile must reset
 * `privacyConfirmed`. A confirmation authorizes ONE outbound destination —
 * identified by its EFFECTIVE URL, not by the profile id. A profile's id is
 * stable across a `baseUrl` upsert, so keying the reset on `profile.id` would
 * let an upsert silently redirect confirmed traffic to a different remote host.
 *
 * Rules (fail-closed on unparseable URLs — treat as a changed destination):
 *   - No previous or no next profile: never reset (nothing to clear).
 *   - Both loopback: never reset (neither needs confirmation; nothing to lose).
 *   - Same effective URL (protocol/host/port/pathname/search): never reset.
 *     Path and query are part of the destination config — a change from
 *     `https://host/v1` to `https://host/other` (or a different query string)
 *     is a changed destination and must reset. Fragment is ignored (it is
 *     never sent to the server).
 *   - Otherwise: reset. This covers remote→different-remote, remote→loopback,
 *     loopback→remote, any upsert that changes the effective URL while keeping
 *     the same profile id, AND any side whose URL failed to parse (a malformed
 *     URL is an unknown destination: two identical malformed values are NOT
 *     treated as equal, so the confirmation always resets).
 */
export function shouldResetConfirmation(
  prev: AiModelProfile | null,
  next: AiModelProfile | null,
): boolean {
  if (!prev || !next) return false
  // Both local — confirmation is irrelevant to either; keep any existing flag.
  if (isOutboundLocal(prev) && isOutboundLocal(next)) return false
  const prevKey = effectiveUrlKey(prev)
  const nextKey = effectiveUrlKey(next)
  // A malformed URL yields `null`. Two `null` keys must NOT compare equal
  // (fail-closed): an unparseable destination is an unknown destination, so
  // any transition involving one resets the confirmation. Only two genuinely
  // equal canonical keys keep the flag.
  if (prevKey !== null && nextKey !== null && prevKey === nextKey) return false
  // Destination changed (or a URL failed to parse — fail-closed): the
  // destination the user confirmed is no longer the one that will receive data.
  return true
}

/**
 * Normalized effective-URL key for destination comparison. Returns the
 * canonical `protocol//host:port/pathname?search` string, or `null` if the URL
 * failed to parse or has no host. `null` is reserved for the invalid case so
 * that two identical malformed URLs never compare equal in
 * `shouldResetConfirmation` (fail-closed). Fragment is excluded — it is never
 * sent to the server, so it cannot be part of the destination config. Loopback
 * URLs are not special here; the loopback-pair short-circuit in
 * `shouldResetConfirmation` is the sole arbiter for local destinations.
 */
function effectiveUrlKey(profile: AiModelProfile): string | null {
  const url = effectiveBaseUrl(profile)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  // Fail-closed: no host means the URL is not a usable destination.
  if (!host) return null
  // Canonical key includes protocol, host, port, pathname, and search.
  // Fragment is intentionally excluded (never sent to the server).
  return `${parsed.protocol}//${host}:${parsed.port}${parsed.pathname}${parsed.search}`
}
