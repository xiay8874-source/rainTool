// Pure-module tests for the AI commit-message proposer (Task 4).
//
// No git, no electron — imports dist-electron/ai-platform/ai-commit-proposer.js
// directly. Covers the four security-critical pure functions:
//   (A) isSecretPath: path-glob exclusion (.env/.pem/.key/id_rsa*/.p12/.keystore/secrets/**)
//   (B) buildStagedContextPrompt: 80 KiB / 12,000-line aggregate cap + excluded/capped handling
//   (C) parseCommitProposal: strict zod validation, tolerant parse, fail-safe (never throws)
//   (D) isRestrictedContent: defense-in-depth content check (sk-/PEM/.env/AWS keys)
//
// Run:  npm run build:electron && node --test tests/git-commit-proposer.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isSecretPath,
  buildStagedContextPrompt,
  parseCommitProposal,
  isRestrictedContent,
  CommitProposalSchema,
  COMMIT_CONTEXT_CAP_BYTES,
  COMMIT_CONTEXT_CAP_LINES,
} from '../dist-electron/ai-platform/ai-commit-proposer.js'

// ===========================================================================
// (A) isSecretPath — path-glob exclusion
// ===========================================================================

test('isSecretPath: matches .env and *.env variants', () => {
  assert.equal(isSecretPath('.env'), true)
  assert.equal(isSecretPath('config.env'), true)
  assert.equal(isSecretPath('.env.local'), true)
  assert.equal(isSecretPath('.env.production'), true)
  assert.equal(isSecretPath('src/config/.env'), true)
  assert.equal(isSecretPath('PROD.ENV'), true, 'case-insensitive')
})

test('isSecretPath: matches PEM / key / p12 / keystore', () => {
  assert.equal(isSecretPath('server.pem'), true)
  assert.equal(isSecretPath('cert/private.key'), true)
  assert.equal(isSecretPath('auth.p12'), true)
  assert.equal(isSecretPath('app.keystore'), true)
  assert.equal(isSecretPath('dist/cert.PEM'), true, 'case-insensitive')
})

test('isSecretPath: matches SSH key files (OpenSSH + classic + wildcard variants)', () => {
  // Exact names (always matched).
  assert.equal(isSecretPath('id_rsa'), true)
  assert.equal(isSecretPath('id_rsa.pub'), true)
  assert.equal(isSecretPath('id_ed25519'), true)
  assert.equal(isSecretPath('id_ecdsa'), true)
  assert.equal(isSecretPath('id_dsa'), true)
  assert.equal(isSecretPath('~/.ssh/id_rsa'), true)
  assert.equal(isSecretPath('ssh/id_ed25519.pub'), true)
  // Wildcard variants (audit fix: `id_rsa*` must match the prefix, not just
  // the exact name — otherwise `id_rsa_backup` / `id_ed25519_github` bypass).
  assert.equal(isSecretPath('id_rsa_backup'), true, 'id_rsa_backup is a secret variant')
  assert.equal(isSecretPath('id_rsa.work'), true, 'id_rsa.work is a secret variant')
  assert.equal(isSecretPath('id_ed25519_github'), true, 'id_ed25519_github is a secret variant')
  assert.equal(isSecretPath('id_ecdsa_sk'), true, 'id_ecdsa_sk is a secret variant')
  assert.equal(isSecretPath('id_dsa.old'), true, 'id_dsa.old is a secret variant')
  assert.equal(isSecretPath('~/.ssh/id_rsa_server1'), true)
  assert.equal(isSecretPath('ID_RSA_BACKUP'), true, 'case-insensitive')
  // A path that merely STARTS with `id_` but isn't a key type is NOT secret.
  assert.equal(isSecretPath('id_config.yaml'), false, 'id_config is not an SSH key')
  assert.equal(isSecretPath('id.txt'), false, 'id.txt is not an SSH key')
})

test('isSecretPath: matches any path under a secrets/ segment', () => {
  assert.equal(isSecretPath('secrets/token.json'), true)
  assert.equal(isSecretPath('src/secrets/db.key'), true)
  assert.equal(isSecretPath('config/secrets/aws-creds.yaml'), true)
  assert.equal(isSecretPath('secrets/sub/inner.txt'), true)
})

test('isSecretPath: REJECTS non-secret source/config files (no false positives)', () => {
  // These look key/env-ish but are legitimate source files.
  assert.equal(isSecretPath('src/env.d.ts'), false, 'TS ambient declaration, not .env')
  assert.equal(isSecretPath('env.d.ts'), false)
  assert.equal(isSecretPath('package.json'), false)
  assert.equal(isSecretPath('src/keymap.ts'), false, 'keymap ≠ private key')
  assert.equal(isSecretPath('src/keyboard.ts'), false)
  assert.equal(isSecretPath('src/server.ts'), false)
  assert.equal(isSecretPath('README.md'), false)
  assert.equal(isSecretPath('src/components/Button.tsx'), false)
  assert.equal(isSecretPath('a/b/c/secrets.txt'), false, 'secrets.txt is a file, not a secrets/ dir')
  assert.equal(isSecretPath(''), false, 'empty path')
  assert.equal(isSecretPath('notenv.txt'), false)
})

// ===========================================================================
// (B) buildStagedContextPrompt — caps + excluded/capped handling
// ===========================================================================

test('buildStagedContextPrompt: under caps → full patches included', () => {
  const files = [
    { path: 'a.txt', status: 'M', patch: 'diff --git a/a.txt b/a.txt\n-version\n+version2' },
    { path: 'b.txt', status: 'A', patch: 'diff --git a/b.txt b/b.txt\n+new file' },
  ]
  const result = buildStagedContextPrompt(files)
  assert.equal(result.excludedPaths.length, 0)
  assert.equal(result.cappedPaths.length, 0)
  assert.equal(result.truncated, false)
  assert.ok(result.totalBytes > 0)
  assert.ok(result.totalLines > 0)
  assert.ok(result.prompt.includes('a.txt'))
  assert.ok(result.prompt.includes('b.txt'))
  assert.ok(result.prompt.includes('version2'), 'full patch content present')
  assert.ok(result.prompt.includes('new file'))
  assert.ok(result.prompt.includes('已暂存变更'), 'header present')
})

test('buildStagedContextPrompt: excluded files → filename + status only, NO patch', () => {
  const files = [
    { path: '.env', status: 'A', patch: 'OPENAI_API_KEY=sk-leak', excluded: true },
    { path: 'a.txt', status: 'M', patch: 'diff --git a/a.txt b/a.txt\n+v2' },
  ]
  const result = buildStagedContextPrompt(files)
  assert.deepEqual(result.excludedPaths, ['.env'])
  assert.equal(result.cappedPaths.length, 0)
  // The excluded file's CONTENT must never appear in the prompt.
  assert.equal(result.prompt.includes('sk-leak'), false, 'excluded patch content must NOT leak')
  assert.ok(result.prompt.includes('.env'), 'excluded filename is present')
  assert.ok(result.prompt.includes('已排除'), 'excluded note present')
})

test('buildStagedContextPrompt: binary + tooLarge files → filename + status only', () => {
  const files = [
    { path: 'logo.png', status: 'A', binary: true },
    { path: 'huge.bin', status: 'M', tooLarge: true },
    { path: 'a.txt', status: 'M', patch: 'diff --git a/a.txt b/a.txt\n+v2' },
  ]
  const result = buildStagedContextPrompt(files)
  assert.equal(result.excludedPaths.length, 0)
  assert.equal(result.cappedPaths.length, 0)
  assert.ok(result.prompt.includes('logo.png'))
  assert.ok(result.prompt.includes('二进制文件'))
  assert.ok(result.prompt.includes('huge.bin'))
  assert.ok(result.prompt.includes('文件过大'))
})

test('buildStagedContextPrompt: aggregate byte cap → overflow files capped', () => {
  // Build files whose combined patches exceed 80 KiB. The first file fills most
  // of the cap; the second overflows → cappedPaths.
  const big = 'diff --git a/big.txt b/big.txt\n' + '+x'.repeat(60 * 1024) // ~120 KiB of patch text
  const files = [
    { path: 'big1.txt', status: 'M', patch: big },
    { path: 'big2.txt', status: 'M', patch: big },
  ]
  const result = buildStagedContextPrompt(files)
  assert.ok(result.truncated, 'aggregate cap reached → truncated=true')
  assert.ok(result.cappedPaths.length >= 1, 'at least one file capped')
  assert.ok(result.totalBytes <= COMMIT_CONTEXT_CAP_BYTES, 'totalBytes respects the cap')
  // The capped file's patch content must NOT be in the prompt.
  assert.ok(result.prompt.includes('已达聚合上限'))
})

test('buildStagedContextPrompt: aggregate line cap → overflow files capped', () => {
  // Stay under the byte cap but exceed 12,000 lines.
  const line = '+line\n'
  const manyLines = line.repeat(8_000) // 8,000 lines, ~48 KiB
  const files = [
    { path: 'a.txt', status: 'M', patch: manyLines },
    { path: 'b.txt', status: 'M', patch: manyLines }, // total 16,000 lines > 12,000
  ]
  const result = buildStagedContextPrompt(files)
  assert.ok(result.truncated, 'line cap reached → truncated=true')
  assert.ok(result.cappedPaths.length >= 1)
  assert.ok(result.totalLines <= COMMIT_CONTEXT_CAP_LINES, 'totalLines respects the cap')
})

test('buildStagedContextPrompt: FINAL-prompt cap bounds filenames+notes, not just patches', () => {
  // Audit regression: thousands of staged files with NO patch text (all
  // binary/tooLarge) must NOT bypass the cap. The old builder counted only
  // patch bytes, so the file list + per-file "二进制" notes (each ~40 bytes)
  // could grow unbounded. The new builder bounds the FINAL assembled prompt.
  // 5,000 binary files × ~40-byte note = ~200 KiB of notes alone — well past
  // the 80 KiB cap, with ZERO patch text.
  const files = []
  for (let i = 0; i < 5_000; i++) {
    files.push({ path: `bin/file_${i}.png`, status: 'A', binary: true })
  }
  const result = buildStagedContextPrompt(files)
  assert.ok(result.truncated, 'notes alone overflowed the cap → truncated=true')
  assert.ok(result.cappedPaths.length > 0, 'overflow files recorded as capped')
  // CRITICAL: the FINAL prompt (headers + list + notes) is under BOTH caps,
  // measured on the ACTUAL assembled string after sections.join('\n\n').
  const actualBytes = Buffer.byteLength(result.prompt, 'utf8')
  const actualLines = result.prompt.split('\n').length
  assert.ok(actualBytes <= COMMIT_CONTEXT_CAP_BYTES, `final prompt bytes ≤ 80 KiB (got ${actualBytes})`)
  assert.ok(actualLines <= COMMIT_CONTEXT_CAP_LINES, `final prompt lines ≤ 12,000 (got ${actualLines})`)
  // The reported totals must match reality (recomputed from the final string).
  assert.equal(result.totalBytes, actualBytes, 'reported totalBytes === actual final-prompt bytes')
  assert.equal(result.totalLines, actualLines, 'reported totalLines === actual final-prompt lines')
})

test('buildStagedContextPrompt: thousands of filenames alone (no patches) bounded by cap', () => {
  // Audit regression: even with NO patches and NO notes (all files have a
  // real but tiny patch), the file-list section alone can overflow. 5,000
  // files × ~25-byte list line = ~125 KiB of list text — past the 80 KiB cap.
  const files = []
  for (let i = 0; i < 5_000; i++) {
    files.push({ path: `src/deep/nested/path/module_${i}.ts`, status: 'M', patch: '+x\n' })
  }
  const result = buildStagedContextPrompt(files)
  assert.ok(result.truncated, 'file list alone overflowed the cap → truncated=true')
  assert.ok(result.cappedPaths.length > 0, 'overflow files recorded as capped')
  const actualBytes = Buffer.byteLength(result.prompt, 'utf8')
  const actualLines = result.prompt.split('\n').length
  assert.ok(actualBytes <= COMMIT_CONTEXT_CAP_BYTES, `final prompt bytes ≤ 80 KiB (got ${actualBytes})`)
  assert.ok(actualLines <= COMMIT_CONTEXT_CAP_LINES, `final prompt lines ≤ 12,000 (got ${actualLines})`)
  assert.equal(result.totalBytes, actualBytes, 'reported totalBytes === actual final-prompt bytes')
  assert.equal(result.totalLines, actualLines, 'reported totalLines === actual final-prompt lines')
})

test('buildStagedContextPrompt: line-cap bypass (many short-line files under byte cap) bounded', () => {
  // Audit regression: a prompt under 80 KiB but over 12,000 LINES must also be
  // truncated. Construct many files each contributing a few short lines so the
  // byte total stays low but the line total explodes. The hard line-cap guard
  // (measured on the actual assembled string) must enforce 12,000.
  // 5,000 files × 4-line patch block = ~20,000 lines, but each line is tiny
  // so the byte total stays well under 80 KiB.
  const files = []
  for (let i = 0; i < 5_000; i++) {
    files.push({ path: `f${i}.ts`, status: 'M', patch: '+a\n+b\n+c\n' })
  }
  const result = buildStagedContextPrompt(files)
  const actualBytes = Buffer.byteLength(result.prompt, 'utf8')
  const actualLines = result.prompt.split('\n').length
  assert.ok(actualBytes <= COMMIT_CONTEXT_CAP_BYTES, `final prompt bytes ≤ 80 KiB (got ${actualBytes})`)
  assert.ok(actualLines <= COMMIT_CONTEXT_CAP_LINES, `final prompt lines ≤ 12,000 (got ${actualLines})`)
  assert.equal(result.totalLines, actualLines, 'reported totalLines === actual final-prompt lines')
  if (actualLines === COMMIT_CONTEXT_CAP_LINES) {
    assert.ok(result.truncated, 'hit the exact line cap → truncated=true')
  }
})

test('buildStagedContextPrompt: byte-trim-first must NOT leave 12,001+ lines (both caps on actual string)', () => {
  // Audit blocking correction: the final hard guard must enforce the LINE cap
  // on the ACTUAL assembled string, not just the byte cap. Construct a case
  // where the byte total exceeds 80 KiB AND the line total exceeds 12,000, so
  // a byte-only trim (that recomputes lines but never re-trims) could leave
  // 12,001+ lines. The iterative guard must satisfy BOTH caps.
  // 4,000 files × 4-line patch ≈ 16,000 lines; each line is long enough that
  // 16,000 lines > 80 KiB, so BOTH caps are breached simultaneously.
  const longLine = '+' + 'x'.repeat(40) + '\n'
  const files = []
  for (let i = 0; i < 4_000; i++) {
    files.push({ path: `f${i}.ts`, status: 'M', patch: longLine + longLine + longLine })
  }
  const result = buildStagedContextPrompt(files)
  const actualBytes = Buffer.byteLength(result.prompt, 'utf8')
  const actualLines = result.prompt.split('\n').length
  // CRITICAL: both caps hold on the ACTUAL final string, not metadata.
  assert.ok(actualBytes <= COMMIT_CONTEXT_CAP_BYTES, `final prompt bytes ≤ 80 KiB (got ${actualBytes})`)
  assert.ok(actualLines <= COMMIT_CONTEXT_CAP_LINES, `final prompt lines ≤ 12,000 (got ${actualLines})`)
  // The reported totals MUST equal the actual measured values (no metadata drift).
  assert.equal(result.totalBytes, actualBytes, 'reported totalBytes === actual final-prompt bytes')
  assert.equal(result.totalLines, actualLines, 'reported totalLines === actual final-prompt lines')
  assert.ok(result.truncated, 'both caps breached → truncated=true')
  // No mid-line split: the prompt ends at a clean line boundary (no U+FFFD).
  assert.equal(result.prompt.endsWith('\uFFFD'), false, 'no orphan replacement char (trimmed at line boundary)')
})

test('buildStagedContextPrompt: rename files show originalPath → path', () => {
  const files = [
    { path: 'new.txt', status: 'R', originalPath: 'old.txt', patch: 'similarity 100%\nrename from old.txt\nrename to new.txt' },
  ]
  const result = buildStagedContextPrompt(files)
  assert.ok(result.prompt.includes('old.txt → new.txt'), 'rename shown as old → new')
})

test('buildStagedContextPrompt: empty input → header + empty summary', () => {
  const result = buildStagedContextPrompt([])
  assert.equal(result.excludedPaths.length, 0)
  assert.equal(result.cappedPaths.length, 0)
  assert.equal(result.truncated, false)
  // totalBytes/totalLines now represent the FINAL assembled prompt (headers
  // included), so empty input still has the header + section headers > 0.
  assert.ok(result.totalBytes > 0, 'headers count toward the final-prompt size')
  assert.ok(result.totalLines > 0)
  assert.ok(result.totalBytes <= COMMIT_CONTEXT_CAP_BYTES, 'under the byte cap')
  assert.ok(result.totalLines <= COMMIT_CONTEXT_CAP_LINES, 'under the line cap')
  assert.ok(result.prompt.includes('已暂存变更'))
})

// ===========================================================================
// (C) parseCommitProposal — strict JSON + bounded plain-text fallback
// ===========================================================================

test('parseCommitProposal: legacy JSON → title only', () => {
  const raw = JSON.stringify({ subject: 'feat: add button', body: 'Details here', rationale: 'Because X' })
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.proposal.subject, 'feat: add button')
    assert.equal(r.proposal.body, '')
    assert.equal(r.proposal.rationale, '')
  }
})

test('parseCommitProposal: markdown-fenced JSON → ok (tolerant)', () => {
  const raw = '```json\n{"subject":"s","body":"","rationale":"r"}\n```'
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.proposal.subject, 's')
})

test('parseCommitProposal: bare code fence → ok (tolerant)', () => {
  const raw = '```\n{"subject":"s","body":"","rationale":"r"}\n```'
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, true)
})

test('parseCommitProposal: JSON with leading/trailing prose → ok (balanced extract)', () => {
  const raw = 'Here is the proposal:\n{"subject":"s","body":"","rationale":"r"}\nHope this helps!'
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, true)
})

test('parseCommitProposal: title-only JSON → ok', () => {
  const raw = JSON.stringify({ subject: 's' })
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.proposal, { subject: 's', body: '', rationale: '' })
  if (!r.ok) assert.ok(r.reason.length > 0)
})

test('parseCommitProposal: extra field → fail (strict)', () => {
  const raw = JSON.stringify({ subject: 's', body: '', rationale: 'r', confidence: 0.9 })
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, false, 'strict mode rejects unknown fields')
})

test('parseCommitProposal: non-JSON text → fail (NOT throw)', () => {
  const r = parseCommitProposal('I cannot help with that.')
  assert.equal(r.ok, false)
})

test('parseCommitProposal: plain conventional commit → editable proposal', () => {
  const r = parseCommitProposal('fix: keep newly created conversations active\n\nAvoid stale hydration overwriting the active conversation.')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.proposal.subject, 'fix: keep newly created conversations active')
    assert.equal(r.proposal.body, '')
    assert.equal(r.proposal.rationale, '')
  }
})

test('parseCommitProposal: JavaScript-style object literal → title only', () => {
  const r = parseCommitProposal('{subject: "Fix model settings and Git workflow"}')
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.proposal, {
    subject: 'Fix model settings and Git workflow',
    body: '',
    rationale: '',
  })
})

test('parseCommitProposal: single-quoted object literal → title only', () => {
  const r = parseCommitProposal("{'subject': 'Improve diagram session switching'}")
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.proposal.subject, 'Improve diagram session switching')
})

test('parseCommitProposal: empty string → fail', () => {
  const r = parseCommitProposal('')
  assert.equal(r.ok, false)
})

test('parseCommitProposal: subject > 100 chars → fail', () => {
  const raw = JSON.stringify({ subject: 'x'.repeat(101), body: '', rationale: 'r' })
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, false)
})

test('parseCommitProposal: explanatory missing-diff response is rejected', () => {
  const r = parseCommitProposal('Thanks for the file list. However, the actual diff content is missing from your message.')
  assert.equal(r.ok, false)
})

test('parseCommitProposal: empty subject → fail (min 1)', () => {
  const raw = JSON.stringify({ subject: '', body: '', rationale: 'r' })
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, false)
})

test('parseCommitProposal: legacy empty rationale is normalized away', () => {
  const raw = JSON.stringify({ subject: 's', body: '', rationale: '' })
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, true)
})

test('parseCommitProposal: body can be empty (max 0 allowed)', () => {
  const raw = JSON.stringify({ subject: 's', body: '', rationale: 'r' })
  const r = parseCommitProposal(raw)
  assert.equal(r.ok, true, 'body is allowed to be empty')
})

test('parseCommitProposal: unclosed legacy JSON → recover title', () => {
  const r = parseCommitProposal('{"subject":"s","body":"","rationale":"r"')
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.proposal.subject, 's')
})

test('CommitProposalSchema: strict mode rejects unknown keys directly', () => {
  const r = CommitProposalSchema.safeParse({ subject: 's', body: '', rationale: 'r', extra: 1 })
  assert.equal(r.success, false)
})

// ===========================================================================
// (D) isRestrictedContent — defense-in-depth content check
// ===========================================================================

test('isRestrictedContent: detects OPENAI_API_KEY=sk-... assignment', () => {
  const patch = '+OPENAI_API_KEY=sk-proj-leak-me-1234567890'
  assert.equal(isRestrictedContent(patch), true)
})

test('isRestrictedContent: detects PEM block', () => {
  const patch = '+-----BEGIN PRIVATE KEY-----\n+MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD...\n+-----END PRIVATE KEY-----'
  assert.equal(isRestrictedContent(patch), true)
})

test('isRestrictedContent: detects AWS access key id', () => {
  const patch = '+AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'
  assert.equal(isRestrictedContent(patch), true)
})

test('isRestrictedContent: rejects ordinary code diff', () => {
  const patch = 'diff --git a/a.txt b/a.txt\n-export const OLD = 1\n+export const NEW = 2'
  assert.equal(isRestrictedContent(patch), false)
})

test('isRestrictedContent: empty string → false', () => {
  assert.equal(isRestrictedContent(''), false)
})
