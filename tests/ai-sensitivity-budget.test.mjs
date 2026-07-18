// P2 sensitivity scanner + context budget gate tests (pure modules).
//
// Covers:
//   - Sensitivity classification: .env assignments, PEM private keys, AWS
//     access keys, AWS secret assignments → restricted; normal text → normal.
//   - The reason string never contains the raw secret.
//   - redactForContext strips detected secrets.
//   - Budget gate: deterministic token estimate, per-attachment bytes/tokens,
//     truncate when over total budget, reject oversize, reject unknown,
//     fail-closed block when ANY attachment is restricted.

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySensitivity, redactForContext } from '../dist-electron/ai-platform/ai-sensitivity-scanner.js'
import { estimateTokens, gateContext, utf8ByteLength } from '../dist-electron/ai-platform/ai-context-budget.js'
import {
  AI_CONTEXT_BUDGET_TOKENS,
  AI_CONTEXT_MAX_ATTACHMENT_BYTES,
} from '../dist-electron/ai-platform/ai-context-types.js'

function makeMeta(overrides = {}) {
  return {
    id: `ctx_test_${Math.random().toString(36).slice(2, 8)}`,
    source: 'manual',
    title: 'test',
    byteSize: 0,
    tokenEstimate: 0,
    sensitivity: 'normal',
    storage: 'ephemeral',
    createdAt: 0,
    expiresAt: Date.now() + 60000,
    ...overrides,
  }
}

function makeAttachment(text, overrides = {}) {
  const byteSize = utf8ByteLength(text)
  const meta = makeMeta({
    byteSize,
    tokenEstimate: estimateTokens(text),
    ...overrides,
  })
  return { meta, text }
}

// ---------------------------------------------------------------------------
// Sensitivity scanner
// ---------------------------------------------------------------------------

test('classifySensitivity: .env-style API key assignment → restricted', () => {
  const r = classifySensitivity('OPENAI_API_KEY=sk-abc123def456')
  assert.equal(r.sensitivity, 'restricted')
  assert.ok(r.reason)
  // The raw secret must not appear in the reason.
  assert.equal(r.reason.includes('sk-abc123def456'), false)
})

test('classifySensitivity: .env-style secret token → restricted', () => {
  const r = classifySensitivity('export GITHUB_TOKEN=ghp_1234567890abcdef')
  assert.equal(r.sensitivity, 'restricted')
  assert.ok(r.reason.includes('GITHUB_TOKEN'))
})

test('classifySensitivity: .env-style password → restricted', () => {
  const r = classifySensitivity('DB_PASSWORD=s3cr3t')
  assert.equal(r.sensitivity, 'restricted')
})

test('classifySensitivity: PEM private key block → restricted', () => {
  const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
  const r = classifySensitivity(text)
  assert.equal(r.sensitivity, 'restricted')
  assert.ok(r.reason.includes('PEM') || r.reason.includes('私钥'))
})

test('classifySensitivity: OpenSSH private key → restricted', () => {
  const text = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA...\n-----END OPENSSH PRIVATE KEY-----'
  const r = classifySensitivity(text)
  assert.equal(r.sensitivity, 'restricted')
})

test('classifySensitivity: AWS access key id (AKIA...) → restricted', () => {
  const r = classifySensitivity('AKIAIOSFODNN7EXAMPLE')
  assert.equal(r.sensitivity, 'restricted')
  assert.ok(r.reason.includes('AWS'))
})

test('classifySensitivity: AWS secret access key assignment → restricted', () => {
  const text = 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  const r = classifySensitivity(text)
  assert.equal(r.sensitivity, 'restricted')
  assert.ok(r.reason.includes('AWS'))
})

test('classifySensitivity: normal JSON/code text → normal', () => {
  assert.equal(classifySensitivity('{"name": "value", "count": 42}').sensitivity, 'normal')
  assert.equal(classifySensitivity('const x = 1 + 2;\nconsole.log(x);').sensitivity, 'normal')
  assert.equal(classifySensitivity('Hello world, this is a normal message.').sensitivity, 'normal')
})

test('classifySensitivity: placeholder .env value (not a secret) → normal', () => {
  // A key name without the secret hint pattern should not be flagged.
  assert.equal(classifySensitivity('PATH=/usr/local/bin:/usr/bin').sensitivity, 'normal')
  assert.equal(classifySensitivity('PORT=3000').sensitivity, 'normal')
})

test('redactForContext: strips detected secrets from a fragment', () => {
  const raw = 'OPENAI_API_KEY=sk-abc123def456 and AKIAIOSFODNN7EXAMPLE'
  const redacted = redactForContext(raw)
  assert.equal(redacted.includes('sk-abc123def456'), false)
  assert.equal(redacted.includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.ok(redacted.includes('••••'))
})

// ---------------------------------------------------------------------------
// Budget gate
// ---------------------------------------------------------------------------

test('estimateTokens: deterministic, chars/4 rounded up, min 1', () => {
  assert.equal(estimateTokens(''), 1)
  assert.equal(estimateTokens('ab'), 1)       // 2 bytes / 4 = 0.5 → 1
  assert.equal(estimateTokens('abcd'), 1)     // 4 bytes / 4 = 1
  assert.equal(estimateTokens('abcde'), 2)    // 5 bytes / 4 = 1.25 → 2
  assert.equal(estimateTokens('abcdefgh'), 2) // 8 bytes / 4 = 2
  // Determinism: same input → same output.
  assert.equal(estimateTokens('hello world'), estimateTokens('hello world'))
})

test('gateContext: single normal attachment within budget → ok, included, contextText assembled', () => {
  const text = 'This is some context the model should see.'
  const result = gateContext([makeAttachment(text)])
  assert.equal(result.blocked, false)
  assert.equal(result.views.length, 1)
  assert.equal(result.views[0].status, 'ok')
  assert.equal(result.views[0].included, true)
  assert.equal(result.views[0].contributedTokens, estimateTokens(text))
  assert.ok(result.contextText.includes(text))
  assert.ok(result.contextText.includes('[附加上下文]'))
  assert.ok(result.contextText.includes('[附加结束]'))
})

test('gateContext: no attachments → empty contextText, not blocked', () => {
  const result = gateContext([])
  assert.equal(result.contextText, '')
  assert.equal(result.blocked, false)
  assert.equal(result.views.length, 0)
  assert.equal(result.totalTokens, 0)
})

test('gateContext: restricted attachment → blocked fail-closed, not included, safe reason', () => {
  const secret = 'OPENAI_API_KEY=sk-leaked-key-1234567890'
  const att = makeAttachment(secret, {
    sensitivity: 'restricted',
    restrictionReason: '检测到 .env 赋值（OPENAI_API_KEY）',
  })
  const result = gateContext([att])
  assert.equal(result.blocked, true)
  assert.ok(result.blockReason)
  assert.equal(result.views[0].status, 'rejected-restricted')
  assert.equal(result.views[0].included, false)
  // The raw secret must not be in the contextText or the blockReason.
  assert.equal(result.contextText.includes(secret), false)
  assert.equal(result.blockReason.includes('sk-leaked'), false)
})

test('gateContext: restricted attachment blocks even when other attachments are normal', () => {
  const normal = makeAttachment('normal context text here')
  const restricted = makeAttachment('SECRET_KEY=topsecret123', {
    sensitivity: 'restricted',
    restrictionReason: '检测到 .env 赋值（SECRET_KEY）',
  })
  const result = gateContext([normal, restricted])
  assert.equal(result.blocked, true)
  // The normal attachment is still classified ok, but the run is blocked.
  assert.equal(result.views[0].status, 'ok')
  assert.equal(result.views[1].status, 'rejected-restricted')
})

test('gateContext: oversize attachment → rejected-oversize, not included', () => {
  // Build a text larger than AI_CONTEXT_MAX_ATTACHMENT_BYTES.
  const huge = 'x'.repeat(AI_CONTEXT_MAX_ATTACHMENT_BYTES + 100)
  const att = makeAttachment(huge)
  const result = gateContext([att])
  assert.equal(result.blocked, false) // oversize is not a security block
  assert.equal(result.views[0].status, 'rejected-oversize')
  assert.equal(result.views[0].included, false)
  assert.equal(result.totalTokens, 0)
  assert.equal(result.contextText, '')
})

test('gateContext: multiple attachments within budget → all ok, tokens sum', () => {
  const a = makeAttachment('first context block')
  const b = makeAttachment('second context block')
  const result = gateContext([a, b])
  assert.equal(result.blocked, false)
  assert.equal(result.views.length, 2)
  assert.equal(result.views[0].status, 'ok')
  assert.equal(result.views[1].status, 'ok')
  assert.equal(result.totalTokens, a.meta.tokenEstimate + b.meta.tokenEstimate)
  assert.ok(result.contextText.includes('first context block'))
  assert.ok(result.contextText.includes('second context block'))
})

test('gateContext: total budget exceeded → later attachment truncated', () => {
  // An attachment that exceeds the per-attachment token cap is rejected-oversize.
  // AI_CONTEXT_MAX_ATTACHMENT_TOKENS = 4000 → need > 16000 bytes.
  const overPerAttCap = 'b'.repeat(16001) // 16001 bytes → 4001 tokens > 4000 cap
  const att = makeAttachment(overPerAttCap)
  const result = gateContext([att])
  assert.equal(result.views[0].status, 'rejected-oversize')
  assert.equal(result.views[0].included, false)
  assert.equal(result.totalTokens, 0)
})

test('gateContext: two attachments within per-attachment cap but exceeding total → second truncated', () => {
  // Each attachment fits the per-attachment cap (4000 tokens = 16000 bytes),
  // but two of them (8000 tokens) hit the total budget (8000). The second
  // should be truncated to fit the remaining budget.
  const fits = 'a'.repeat(12000) // 12000 bytes → 3000 tokens, within 4000 per-att cap
  const a = makeAttachment(fits)
  const b = makeAttachment(fits)
  const result = gateContext([a, b])
  // First is ok (3000 < 8000 total). Second: 6000 < 8000, still ok.
  assert.equal(result.views[0].status, 'ok')
  assert.equal(result.views[1].status, 'ok')
  assert.equal(result.totalTokens, 6000)
  // Now add a third — 9000 > 8000 total, so the third is truncated.
  const c = makeAttachment(fits)
  const result2 = gateContext([a, b, c])
  assert.equal(result2.views[0].status, 'ok')
  assert.equal(result2.views[1].status, 'ok')
  // Third must be truncated (remaining budget = 2000 tokens).
  assert.equal(result2.views[2].status, 'truncated')
  assert.equal(result2.views[2].included, true)
  assert.ok(result2.views[2].contributedTokens <= 2000, 'truncated attachment exceeded remaining budget')
})
