// Privacy-gate eligibility tests (pure helper, no DOM/store).
//
// The shared `eligibilityReason` helper is the single source of truth for
// whether a run may start. The renderer's Send button + Enter key route
// through it, and the store re-checks it in startRun as defense-in-depth.
// These tests pin the outbound-privacy gate contract:
//
//   - A profile whose effective base URL leaves this machine (cloud, LAN, or a
//     remote override on an Ollama profile) requires `privacyConfirmed` before
//     the first send. Unconfirmed → blocked with `needs-confirmation`.
//   - A loopback profile (Ollama default, or any Base URL on
//     127.0.0.1/localhost/::1) is exempt: it never leaves this machine, so no
//     confirmation is required.
//   - Missing conversation/profile, streaming, and empty input each block with
//     their own distinct reason.
//
// The exemption is decided by the EFFECTIVE URL, not the provider id — a
// user can point either provider id at any host, so the URL is the truth about
// where the conversation text is sent.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canStartRun,
  effectiveBaseUrl,
  eligibilityReason,
  isLoopbackBaseUrl,
  isOutboundLocal,
  shouldResetConfirmation,
} from '../dist-electron/ai-platform/ai-eligibility.js'

/** Build a profile with sensible P1 defaults; override per test. */
function profile(overrides = {}) {
  return {
    id: 'prof_test',
    providerId: 'openai-compatible',
    displayName: 'Test',
    model: 'gpt-4o-mini',
    baseUrl: undefined,
    credentialKey: 'cred_test',
    capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

const CONVERSATION = { id: 'conv_test' }

function state(overrides = {}) {
  return {
    activeConversation: CONVERSATION,
    activeProfile: profile(),
    runStatus: 'idle',
    privacyConfirmed: false,
    input: 'hi',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// effectiveBaseUrl + isLoopbackBaseUrl + isOutboundLocal unit cases
// ---------------------------------------------------------------------------

test('effectiveBaseUrl: ollama defaults to loopback, openai-compatible defaults to cloud', () => {
  assert.equal(effectiveBaseUrl(profile({ providerId: 'ollama' })), 'http://127.0.0.1:11434/v1')
  assert.equal(effectiveBaseUrl(profile({ providerId: 'openai-compatible' })), 'https://api.openai.com/v1')
})

test('effectiveBaseUrl: explicit baseUrl override wins for both providers', () => {
  assert.equal(
    effectiveBaseUrl(profile({ providerId: 'ollama', baseUrl: 'https://remote.example.com/v1' })),
    'https://remote.example.com/v1',
  )
  assert.equal(
    effectiveBaseUrl(profile({ providerId: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })),
    'http://localhost:1234/v1',
  )
})

test('isLoopbackBaseUrl: 127.0.0.1 / localhost / ::1 on any port are loopback', () => {
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:11434/v1'), true)
  assert.equal(isLoopbackBaseUrl('http://localhost:5173'), true)
  assert.equal(isLoopbackBaseUrl('http://[::1]:8080/v1'), true)
  assert.equal(isLoopbackBaseUrl('https://127.0.0.1'), true)
})

test('isLoopbackBaseUrl: cloud, LAN, and malformed URLs are NOT loopback (fail-closed)', () => {
  assert.equal(isLoopbackBaseUrl('https://api.openai.com/v1'), false)
  assert.equal(isLoopbackBaseUrl('http://192.168.1.5:1234/v1'), false)
  assert.equal(isLoopbackBaseUrl('http://10.0.0.1/v1'), false)
  assert.equal(isLoopbackBaseUrl('not a url'), false)
  assert.equal(isLoopbackBaseUrl(''), false)
})

test('isOutboundLocal: ollama default exempt; ollama remote override NOT exempt', () => {
  assert.equal(isOutboundLocal(profile({ providerId: 'ollama' })), true)
  assert.equal(isOutboundLocal(profile({ providerId: 'ollama', baseUrl: 'https://remote.example.com/v1' })), false)
})

test('isOutboundLocal: openai-compatible default NOT exempt; localhost override exempt', () => {
  assert.equal(isOutboundLocal(profile({ providerId: 'openai-compatible' })), false)
  assert.equal(isOutboundLocal(profile({ providerId: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })), true)
})

// ---------------------------------------------------------------------------
// eligibilityReason: the outbound-privacy gate
// ---------------------------------------------------------------------------

test('unconfirmed cloud profile (openai-compatible default) is BLOCKED with needs-confirmation', () => {
  const r = eligibilityReason(state({ privacyConfirmed: false }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'needs-confirmation')
  // The raw key / provider detail must not leak into the UI message.
  assert.equal(r.message.includes('sk-'), false)
})

test('confirmed cloud profile is ALLOWED', () => {
  const r = eligibilityReason(state({ privacyConfirmed: true }))
  assert.equal(r.ok, true)
})

test('unconfirmed ollama (default loopback) is ALLOWED — loopback exemption', () => {
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'ollama' }),
    privacyConfirmed: false,
  }))
  assert.equal(r.ok, true)
})

test('unconfirmed ollama with REMOTE baseUrl override is BLOCKED — exemption is URL-based, not provider-id-based', () => {
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'ollama', baseUrl: 'https://remote.example.com/v1' }),
    privacyConfirmed: false,
  }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'needs-confirmation')
})

test('unconfirmed openai-compatible pointed at localhost is ALLOWED — local LM Studio exemption', () => {
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }),
    privacyConfirmed: false,
  }))
  assert.equal(r.ok, true)
})

test('unconfirmed openai-compatible pointed at a LAN address is BLOCKED — LAN is not loopback', () => {
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'openai-compatible', baseUrl: 'http://192.168.1.5:1234/v1' }),
    privacyConfirmed: false,
  }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'needs-confirmation')
})

test('no active conversation is BLOCKED with no-conversation (before confirmation check)', () => {
  const r = eligibilityReason(state({ activeConversation: null, privacyConfirmed: false }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-conversation')
})

test('no active profile is BLOCKED with no-profile (before confirmation check)', () => {
  const r = eligibilityReason(state({ activeProfile: null, privacyConfirmed: false }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-profile')
})

test('streaming runStatus is BLOCKED with streaming (before confirmation check)', () => {
  const r = eligibilityReason(state({ runStatus: 'streaming', privacyConfirmed: false }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'streaming')
})

test('cancelling runStatus is also BLOCKED with streaming', () => {
  const r = eligibilityReason(state({ runStatus: 'cancelling', privacyConfirmed: false }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'streaming')
})

test('empty / whitespace input is BLOCKED with empty (before confirmation check)', () => {
  assert.equal(eligibilityReason(state({ input: '', privacyConfirmed: false })).reason, 'empty')
  assert.equal(eligibilityReason(state({ input: '   \n\t  ', privacyConfirmed: false })).reason, 'empty')
})

test('confirmed + all-valid is ALLOWED; canStartRun mirrors eligibilityReason.ok', () => {
  const s = state({ privacyConfirmed: true, input: 'hello world' })
  assert.equal(eligibilityReason(s).ok, true)
  assert.equal(canStartRun(s), true)
})

test('check ordering: missing profile wins over needs-confirmation even with cloud profile unconfirmed', () => {
  // A cloud profile that would need confirmation — but no conversation is
  // selected, so the more actionable 'no-conversation' reason wins.
  const r = eligibilityReason(state({
    activeConversation: null,
    activeProfile: profile({ providerId: 'openai-compatible' }),
    privacyConfirmed: false,
    input: 'hi',
  }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-conversation')
})

test('check ordering: empty input wins over needs-confirmation for unconfirmed cloud', () => {
  // Unconfirmed cloud, but no text — 'empty' is more actionable than asking
  // for confirmation of an empty message.
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'openai-compatible' }),
    privacyConfirmed: false,
    input: '',
  }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty')
})

test('every blocked reason returns a non-empty Chinese message safe for the UI', () => {
  const cases = [
    state({ activeConversation: null }),
    state({ activeProfile: null }),
    state({ runStatus: 'streaming' }),
    state({ input: '' }),
    state({ activeProfile: profile({ providerId: 'openai-compatible' }), privacyConfirmed: false }),
  ]
  for (const s of cases) {
    const r = eligibilityReason(s)
    assert.equal(r.ok, false)
    assert.ok(r.message.length > 0, `empty message for reason ${r.reason}`)
    // No raw key or URL detail in the UI-facing message.
    assert.equal(r.message.includes('sk-'), false)
    assert.equal(r.message.includes('http'), false)
  }
})

// ---------------------------------------------------------------------------
// P2: unavailable-attachments fail-closed gate
// ---------------------------------------------------------------------------

test('P2: an unavailable attachment chip (payloadAvailable:false) BLOCKS with unavailable-attachments', () => {
  // A confirmed loopback profile with valid input — would normally be allowed.
  // But one selected chip lost its payload (e.g. after a restart). The gate
  // blocks fail-closed: the runtime's vault would reject the id, so the run
  // must not start. No silent ignore.
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'ollama' }), // loopback → no confirmation needed
    privacyConfirmed: false,
    input: 'hi',
    attachments: [
      { payloadAvailable: true },
      { payloadAvailable: false }, // unavailable — lost payload
    ],
  }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unavailable-attachments')
  assert.ok(r.message.length > 0)
  // The message must tell the user to remove or re-attach — not "will be ignored".
  assert.equal(r.message.includes('忽略'), false, 'message must not say "will be ignored"')
  assert.ok(r.message.includes('失效') || r.message.includes('移除') || r.message.includes('附加'), 'message must guide the user to fix it')
})

test('P2: all-available attachments ALLOW the run (no false block)', () => {
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'ollama' }),
    privacyConfirmed: false,
    input: 'hi',
    attachments: [
      { payloadAvailable: true },
      { payloadAvailable: true },
    ],
  }))
  assert.equal(r.ok, true)
})

test('P2: no attachments field → allowed (backward-compatible; attachments optional)', () => {
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'ollama' }),
    privacyConfirmed: false,
    input: 'hi',
  }))
  assert.equal(r.ok, true)
})

test('P2: empty attachments array → allowed', () => {
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'ollama' }),
    privacyConfirmed: false,
    input: 'hi',
    attachments: [],
  }))
  assert.equal(r.ok, true)
})

test('P2: unavailable-attachments reason is checked AFTER needs-confirmation (cloud unconfirmed wins)', () => {
  // An unconfirmed CLOUD profile with an unavailable chip: the privacy gate
  // fires first (it is the more actionable blocker — the user hasn't authorized
  // outbound at all). The unavailable-attachments reason only matters once the
  // run would otherwise proceed.
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'openai-compatible' }), // cloud → needs confirmation
    privacyConfirmed: false,
    input: 'hi',
    attachments: [{ payloadAvailable: false }],
  }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'needs-confirmation', 'privacy gate must fire before the attachment gate')
})

test('P2: confirmed cloud + unavailable chip → blocked with unavailable-attachments', () => {
  // Once the user HAS confirmed outbound, the unavailable chip becomes the
  // actionable blocker.
  const r = eligibilityReason(state({
    activeProfile: profile({ providerId: 'openai-compatible' }),
    privacyConfirmed: true,
    input: 'hi',
    attachments: [{ payloadAvailable: false }],
  }))
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unavailable-attachments')
})

test('P2: canStartRun mirrors eligibilityReason for unavailable attachments', () => {
  const blocked = state({
    activeProfile: profile({ providerId: 'ollama' }),
    input: 'hi',
    attachments: [{ payloadAvailable: false }],
  })
  assert.equal(canStartRun(blocked), false)
  const allowed = state({
    activeProfile: profile({ providerId: 'ollama' }),
    input: 'hi',
    attachments: [{ payloadAvailable: true }],
  })
  assert.equal(canStartRun(allowed), true)
})

// ---------------------------------------------------------------------------
// shouldResetConfirmation: confirmation is destination-bound (by effective URL)
// ---------------------------------------------------------------------------

const CLOUD_A = profile({ id: 'prof_cloud_a', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
const CLOUD_B = profile({ id: 'prof_cloud_b', providerId: 'openai-compatible', baseUrl: 'https://api.openrouter.ai/v1' })
// Same destination as CLOUD_A but a DIFFERENT profile id — used to prove the
// reset keys on the effective URL, not the id.
const CLOUD_A_ALIASED = profile({ id: 'prof_cloud_a_alias', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
const OLLAMA_DEFAULT = profile({ id: 'prof_ollama', providerId: 'ollama' }) // loopback
const LM_STUDIO = profile({ id: 'prof_lmstudio', providerId: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }) // loopback
const OLLAMA_REMOTE = profile({ id: 'prof_ollama_remote', providerId: 'ollama', baseUrl: 'https://remote.example.com/v1' }) // remote

test('shouldResetConfirmation: null prev or null next → false (nothing to clear)', () => {
  assert.equal(shouldResetConfirmation(null, CLOUD_A), false)
  assert.equal(shouldResetConfirmation(CLOUD_A, null), false)
  assert.equal(shouldResetConfirmation(null, null), false)
})

test('shouldResetConfirmation: same effective URL → false, even across DIFFERENT profile ids', () => {
  // Identical profile object (same id, same URL).
  assert.equal(shouldResetConfirmation(CLOUD_A, CLOUD_A), false)
  // Different profile id but SAME effective URL → same destination; keep the
  // confirmation. (Two profiles pointed at the same endpoint.)
  assert.equal(shouldResetConfirmation(CLOUD_A, CLOUD_A_ALIASED), false)
  assert.equal(shouldResetConfirmation(CLOUD_A_ALIASED, CLOUD_A), false)
})

test('shouldResetConfirmation: remote→different remote → true (different destination authorized)', () => {
  assert.equal(shouldResetConfirmation(CLOUD_A, CLOUD_B), true)
})

test('shouldResetConfirmation: remote→loopback → true (destination changed; harmless reset)', () => {
  assert.equal(shouldResetConfirmation(CLOUD_A, OLLAMA_DEFAULT), true)
  assert.equal(shouldResetConfirmation(CLOUD_A, LM_STUDIO), true)
})

test('shouldResetConfirmation: loopback→remote → true (must re-confirm the new remote destination)', () => {
  assert.equal(shouldResetConfirmation(OLLAMA_DEFAULT, CLOUD_A), true)
  assert.equal(shouldResetConfirmation(LM_STUDIO, CLOUD_A), true)
})

test('shouldResetConfirmation: loopback→loopback → false (neither needs confirmation; keep flag)', () => {
  assert.equal(shouldResetConfirmation(OLLAMA_DEFAULT, LM_STUDIO), false)
  assert.equal(shouldResetConfirmation(LM_STUDIO, OLLAMA_DEFAULT), false)
})

test('shouldResetConfirmation: ollama default→ollama remote override → true (loopback→remote)', () => {
  // Same provider id, different effective URL (loopback → remote): the
  // destination changed from local to remote, so confirmation must reset.
  assert.equal(shouldResetConfirmation(OLLAMA_DEFAULT, OLLAMA_REMOTE), true)
})

test('shouldResetConfirmation: ollama remote→ollama default → true (remote→loopback)', () => {
  assert.equal(shouldResetConfirmation(OLLAMA_REMOTE, OLLAMA_DEFAULT), true)
})

// CRITICAL: the reset must key on the effective URL, NOT the profile id. A
// profile id is stable across a `baseUrl` upsert, so keying on id would let an
// upsert silently redirect confirmed traffic to a different remote host. This
// is the regression the independent review flagged.
test('shouldResetConfirmation: SAME id but baseUrl upsert to a DIFFERENT remote URL → true (upsert cannot inherit confirmation)', () => {
  const before = profile({ id: 'prof_cloud_a', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
  const after = profile({ id: 'prof_cloud_a', providerId: 'openai-compatible', baseUrl: 'https://api.openrouter.ai/v1' })
  assert.equal(before.id, after.id, 'sanity: same profile id (upsert, not switch)')
  assert.notEqual(before.baseUrl, after.baseUrl, 'sanity: URL changed')
  assert.equal(shouldResetConfirmation(before, after), true, 'upsert changing the remote URL must reset confirmation')
})

test('shouldResetConfirmation: SAME id and SAME baseUrl (no-op upsert) → false', () => {
  const before = profile({ id: 'prof_cloud_a', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
  const after = profile({ id: 'prof_cloud_a', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
  assert.equal(shouldResetConfirmation(before, after), false)
})

test('shouldResetConfirmation: same id, baseUrl upsert from remote to loopback → true (destination changed)', () => {
  const before = profile({ id: 'prof_x', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
  const after = profile({ id: 'prof_x', providerId: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' })
  assert.equal(shouldResetConfirmation(before, after), true)
})

test('shouldResetConfirmation: same id, baseUrl upsert from loopback to remote → true (must re-confirm)', () => {
  const before = profile({ id: 'prof_x', providerId: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' })
  const after = profile({ id: 'prof_x', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
  assert.equal(shouldResetConfirmation(before, after), true)
})

// End-to-end: the store delegates to shouldResetConfirmation on profile switch
// AND on loadProfiles (upsert). Here we prove the pure decision the store
// relies on. The combination below is the critical privacy regression:
// confirming CLOUD_A then switching to CLOUD_B must reset so CLOUD_B cannot
// inherit CLOUD_A's authorization.
test('regression: confirming a remote profile then switching to a DIFFERENT remote profile resets confirmation', () => {
  // Simulate the store's decision: prev=CLOUD_A (confirmed), next=CLOUD_B.
  const reset = shouldResetConfirmation(CLOUD_A, CLOUD_B)
  assert.equal(reset, true, 'switching remote→different-remote must reset privacyConfirmed')
  // After reset, the gate blocks CLOUD_B until re-confirmed.
  const r = eligibilityReason({
    activeConversation: CONVERSATION,
    activeProfile: CLOUD_B,
    runStatus: 'idle',
    privacyConfirmed: false, // reset by the switch
    input: 'hi',
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'needs-confirmation')
})

// End-to-end upsert regression: user confirms CLOUD_A, then edits CLOUD_A's
// baseUrl to point at a different remote host (same id, different URL). The
// store's loadProfiles runs shouldResetConfirmation(prevActive, nextActive)
// with the same id but a different URL; confirmation MUST reset so the new
// remote destination cannot inherit the old one's authorization.
test('regression: confirming a remote profile, then UPSERTING its baseUrl to a different remote URL resets confirmation', () => {
  const confirmed = profile({ id: 'prof_cloud_a', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
  const upserted = profile({ id: 'prof_cloud_a', providerId: 'openai-compatible', baseUrl: 'https://api.openrouter.ai/v1' })
  const reset = shouldResetConfirmation(confirmed, upserted)
  assert.equal(reset, true, 'upsert changing the remote URL must reset privacyConfirmed')
  // After reset, the gate blocks the upserted profile until re-confirmed.
  const r = eligibilityReason({
    activeConversation: CONVERSATION,
    activeProfile: upserted,
    runStatus: 'idle',
    privacyConfirmed: false, // reset by the upsert
    input: 'hi',
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'needs-confirmation')
})

// ---------------------------------------------------------------------------
// effectiveUrlKey canonical comparison: path/query/fragment semantics
// (path + query are part of the destination; fragment is never sent)
// ---------------------------------------------------------------------------

test('shouldResetConfirmation: same host, DIFFERENT path → true (path is part of destination)', () => {
  const a = profile({ id: 'p1', providerId: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1' })
  const b = profile({ id: 'p2', providerId: 'openai-compatible', baseUrl: 'https://gateway.example.com/other' })
  assert.equal(shouldResetConfirmation(a, b), true)
})

test('shouldResetConfirmation: same host, DIFFERENT query → true (query is part of destination)', () => {
  const a = profile({ id: 'p1', providerId: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1?api-version=2024' })
  const b = profile({ id: 'p2', providerId: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1?api-version=2025' })
  assert.equal(shouldResetConfirmation(a, b), true)
})

test('shouldResetConfirmation: same host/path/query, DIFFERENT fragment → false (fragment is never sent)', () => {
  const a = profile({ id: 'p1', providerId: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1?x=1#section-a' })
  const b = profile({ id: 'p2', providerId: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1?x=1#section-b' })
  assert.equal(shouldResetConfirmation(a, b), false, 'fragment differences must NOT reset (fragment is not sent)')
})

test('shouldResetConfirmation: same host/path/query/port (control) → false', () => {
  const a = profile({ id: 'p1', providerId: 'openai-compatible', baseUrl: 'https://gateway.example.com:443/v1?q=1' })
  const b = profile({ id: 'p2', providerId: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1?q=1' })
  // :443 is the default for https; URL normalizes so these are the same dest.
  assert.equal(shouldResetConfirmation(a, b), false)
})

// Fail-closed: a malformed URL is an unknown destination. Two IDENTICAL
// malformed values must still reset — `__invalid__:x`-style keys that compare
// equal would silently keep confirmation, violating the fail-closed contract.
test('shouldResetConfirmation: same malformed URL twice → true (fail-closed: invalid never compares equal)', () => {
  const malformed = 'not-a-valid-url'
  const a = profile({ id: 'p1', providerId: 'openai-compatible', baseUrl: malformed })
  const b = profile({ id: 'p2', providerId: 'openai-compatible', baseUrl: malformed })
  assert.equal(shouldResetConfirmation(a, b), true, 'two identical malformed URLs must still reset (fail-closed)')
})

test('shouldResetConfirmation: malformed → valid URL → true (invalid side forces reset)', () => {
  const malformed = profile({ id: 'p1', providerId: 'openai-compatible', baseUrl: 'not-a-valid-url' })
  const valid = profile({ id: 'p2', providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
  assert.equal(shouldResetConfirmation(malformed, valid), true)
  assert.equal(shouldResetConfirmation(valid, malformed), true)
})

test('shouldResetConfirmation: empty-string baseUrl on a non-ollama provider → true (malformed → reset)', () => {
  // openai-compatible with empty baseUrl → effectiveBaseUrl returns the
  // default https://api.openai.com/v1, which is valid; to exercise the
  // malformed path we force a provider whose default is also malformed.
  // Use a baseUrl that is whitespace-only, which URL cannot parse.
  const a = profile({ id: 'p1', providerId: 'openai-compatible', baseUrl: '   ' })
  const b = profile({ id: 'p2', providerId: 'openai-compatible', baseUrl: '   ' })
  assert.equal(shouldResetConfirmation(a, b), true)
})
