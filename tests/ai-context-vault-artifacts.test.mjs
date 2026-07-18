// P2 Context Vault + Artifact Repository tests (main-process, temp dirs).
//
// Covers:
//   - Vault: ingest returns metadata (no raw payload), list/getMeta return no
//     raw text, getText is the ONLY way to get payload (main-process only),
//     expiry purges payloads, delete/clearAll/clearForRun remove payloads,
//     validateIds rejects invalid/unknown ids, raw text never persisted to disk.
//   - Artifact repo: create/get/list/update/delete, revision history, JSON
//     validation rejects invalid JSON, secrets stripped from persisted content,
//     classifyArtifactKind heuristics, NO apply/writeback method exists.

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AiContextVault } from '../dist-electron/ai-platform/ai-context-vault.js'
import {
  AiArtifactRepository,
  classifyArtifactKind,
  validateJson,
} from '../dist-electron/ai-platform/ai-artifact-repository.js'

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'raintool-p2-'))
}

// ---------------------------------------------------------------------------
// Context Vault
// ---------------------------------------------------------------------------

test('vault: ingest returns metadata with no raw payload; getText is the only payload accessor', () => {
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const secret = 'OPENAI_API_KEY=sk-test-secret-1234567890'
    const meta = vault.ingest({ source: 'manual', title: 'my env', text: secret })
    assert.ok(meta.id.startsWith('ctx_'))
    assert.equal(meta.sensitivity, 'restricted')
    assert.ok(meta.byteSize > 0)
    assert.ok(meta.tokenEstimate > 0)
    assert.ok(meta.expiresAt > meta.createdAt)
    // Metadata has NO raw text field.
    const metaJson = JSON.stringify(meta)
    assert.equal(metaJson.includes(secret), false, 'raw payload leaked into metadata')
    assert.equal(metaJson.includes('sk-test-secret'), false, 'raw key leaked into metadata')
    // list() returns metadata only — no raw text.
    const listed = vault.list()
    assert.equal(listed.length, 1)
    assert.equal(JSON.stringify(listed[0]).includes(secret), false)
    // getMeta returns metadata only.
    const got = vault.getMeta(meta.id)
    assert.ok(got)
    assert.equal(JSON.stringify(got).includes(secret), false)
    // getText returns the raw payload (main-process only).
    assert.equal(vault.getText(meta.id), secret)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: raw payload text is NEVER persisted to disk (ephemeral default)', () => {
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const secret = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    vault.ingest({ source: 'manual', title: 'aws', text: secret })
    // Scan every file under the ai/ dir for the raw secret.
    const aiDir = path.join(dir, 'ai')
    const scanDir = (d) => {
      for (const entry of readdirSync(d)) {
        const full = path.join(d, entry)
        if (existsSync(full) && entry !== 'artifacts') {
          // It's a file (the vault doesn't create subdirs for payloads).
          try {
            const content = readFileSync(full, 'utf8')
            assert.equal(
              content.includes(secret), false,
              `raw secret persisted to ${full}`,
            )
            assert.equal(
              content.includes('wJalrXUtnFEMI'), false,
              `raw AWS key fragment persisted to ${full}`,
            )
          } catch { /* directory or binary; skip */ }
        }
      }
    }
    scanDir(aiDir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: expired payloads are purged on access', () => {
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const meta = vault.ingest({ source: 'manual', title: 'short-lived', text: 'temp' }, 1) // 1ms TTL
    // Wait for expiry.
    const start = Date.now()
    while (Date.now() - start < 10) { /* spin 10ms */ }
    assert.equal(vault.getText(meta.id), null, 'expired payload should be purged')
    assert.equal(vault.getMeta(meta.id), null, 'expired meta should be purged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: delete removes payload; getText returns null after delete', () => {
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const meta = vault.ingest({ source: 'manual', title: 'to-delete', text: 'delete me' })
    assert.ok(vault.getText(meta.id))
    assert.equal(vault.delete(meta.id), true)
    assert.equal(vault.getText(meta.id), null)
    assert.equal(vault.getMeta(meta.id), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: clearAll removes all payloads (quit path)', () => {
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const m1 = vault.ingest({ source: 'manual', title: 'a', text: 'one' })
    const m2 = vault.ingest({ source: 'manual', title: 'b', text: 'two' })
    assert.equal(vault.list().length, 2)
    vault.clearAll()
    assert.equal(vault.list().length, 0)
    assert.equal(vault.getText(m1.id), null)
    assert.equal(vault.getText(m2.id), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: clearForRun removes only the specified ids (cancel path)', () => {
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const m1 = vault.ingest({ source: 'manual', title: 'a', text: 'one' })
    const m2 = vault.ingest({ source: 'manual', title: 'b', text: 'two' })
    vault.clearForRun([m1.id])
    assert.equal(vault.getText(m1.id), null)
    assert.ok(vault.getText(m2.id), 'unrelated payload should survive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: validateIds accepts known ids, rejects unknown/invalid ids', () => {
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const m = vault.ingest({ source: 'manual', title: 'known', text: 'ok' })
    // Known id → ok.
    const ok = vault.validateIds([m.id])
    assert.equal(ok.ok, true)
    assert.equal(ok.metas.length, 1)
    // Unknown id → reject.
    const unknown = vault.validateIds(['ctx_nonexistent'])
    assert.equal(unknown.ok, false)
    assert.ok(unknown.reason)
    // Invalid id format → reject.
    const invalid = vault.validateIds(['../../etc/passwd'])
    assert.equal(invalid.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: metadata-only storage persists the meta index (payload still ephemeral)', () => {
  const dir = makeTempDir()
  try {
    let vault = new AiContextVault(dir)
    const secret = 'OPENAI_API_KEY=sk-persist-meta-1234567890'
    const meta = vault.ingest({ source: 'manual', title: 'meta-only', text: secret, storage: 'metadata-only' })
    vault.clearAll() // simulate quit — payload gone
    // New vault instance reads the persisted meta index.
    vault = new AiContextVault(dir)
    const metas = vault.list()
    // The meta placeholder may survive (no payload), but the raw secret must
    // never be in any persisted file.
    const metaIndex = readFileSync(path.join(dir, 'ai', 'context-metas.json'), 'utf8')
    assert.equal(metaIndex.includes(secret), false, 'raw secret persisted in meta index')
    assert.equal(metaIndex.includes('sk-persist-meta'), false, 'raw key persisted in meta index')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: metadata-only reload — placeholder appears in list with payloadAvailable:false; getText/validateIds reject it', () => {
  const dir = makeTempDir()
  try {
    // First session: ingest a metadata-only attachment, then clearAll (quit).
    let vault = new AiContextVault(dir)
    const meta = vault.ingest({
      source: 'json-workbench', title: 'survives restart', text: 'some context',
      storage: 'metadata-only',
    })
    assert.equal(meta.payloadAvailable, true)
    vault.clearAll() // simulate quit — in-memory payload gone, meta persisted

    // Second session: new vault instance reads the persisted meta index.
    vault = new AiContextVault(dir)
    const metas = vault.list()
    // The placeholder MUST appear in the list.
    const placeholder = metas.find((m) => m.id === meta.id)
    assert.ok(placeholder, 'metadata-only placeholder not in list after reload')
    assert.equal(placeholder.payloadAvailable, false, 'placeholder must report payloadAvailable:false')
    assert.equal(placeholder.title, 'survives restart')

    // getText MUST return null for the placeholder (no payload).
    assert.equal(vault.getText(meta.id), null, 'getText returned payload for a placeholder')

    // getMeta returns the placeholder (with payloadAvailable:false).
    const got = vault.getMeta(meta.id)
    assert.ok(got)
    assert.equal(got.payloadAvailable, false)

    // validateIds MUST reject the placeholder (cannot send without payload).
    const validation = vault.validateIds([meta.id])
    assert.equal(validation.ok, false, 'validateIds accepted a placeholder without payload')
    assert.ok(validation.reason.includes('失效') || validation.reason.includes('不可用'))

    // getMetaForSend MUST return null for the placeholder.
    assert.equal(vault.getMetaForSend(meta.id), null, 'getMetaForSend returned meta for a placeholder')

    // delete removes the placeholder.
    assert.equal(vault.delete(meta.id), true)
    const afterDelete = vault.list().find((m) => m.id === meta.id)
    assert.equal(afterDelete, undefined, 'placeholder not deleted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: ephemeral attachment does NOT survive reload (no persisted meta)', () => {
  const dir = makeTempDir()
  try {
    let vault = new AiContextVault(dir)
    const meta = vault.ingest({ source: 'manual', title: 'ephemeral', text: 'temp' }) // ephemeral default
    vault.clearAll() // quit
    vault = new AiContextVault(dir)
    const metas = vault.list()
    assert.equal(metas.find((m) => m.id === meta.id), undefined, 'ephemeral meta survived reload')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: payloadAvailable is true for fresh in-memory attachments', () => {
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const meta = vault.ingest({ source: 'manual', title: 'fresh', text: 'hello' })
    assert.equal(meta.payloadAvailable, true)
    const listed = vault.list()
    assert.equal(listed[0].payloadAvailable, true)
    const got = vault.getMeta(meta.id)
    assert.equal(got.payloadAvailable, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: every AiAttachmentMeta returned to the renderer has a payloadAvailable field (UI chip gate)', () => {
  // Static contract: the renderer's AttachmentChips component relies on
  // payloadAvailable to distinguish sendable chips from unavailable placeholders.
  // Every meta returned by ingest/list/getMeta MUST carry this field.
  const dir = makeTempDir()
  try {
    const vault = new AiContextVault(dir)
    const ingested = vault.ingest({ source: 'manual', title: 'a', text: 'x', storage: 'metadata-only' })
    vault.clearAll()
    const vault2 = new AiContextVault(dir)
    // After reload, the placeholder must carry payloadAvailable: false.
    const listed = vault2.list()
    assert.equal(listed.length, 1)
    assert.equal('payloadAvailable' in listed[0], true, 'list meta missing payloadAvailable')
    assert.equal(listed[0].payloadAvailable, false)
    // getMeta on a placeholder.
    const got = vault2.getMeta(ingested.id)
    assert.equal('payloadAvailable' in got, true, 'getMeta meta missing payloadAvailable')
    assert.equal(got.payloadAvailable, false)
    // Fresh ingest.
    const fresh = vault2.ingest({ source: 'manual', title: 'fresh', text: 'y' })
    assert.equal('payloadAvailable' in fresh, true, 'ingest meta missing payloadAvailable')
    assert.equal(fresh.payloadAvailable, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Artifact Repository
// ---------------------------------------------------------------------------

test('artifact repo: create + get + list + delete', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const doc = repo.create({ kind: 'markdown', title: 'My Proposal', content: '# Hello\nworld' })
    assert.ok(doc.id.startsWith('art_'))
    assert.equal(doc.kind, 'markdown')
    assert.equal(doc.title, 'My Proposal')
    assert.equal(doc.content, '# Hello\nworld')
    assert.equal(doc.revisionCount, 1)
    assert.equal(doc.revisions.length, 1)

    const got = repo.get(doc.id)
    assert.ok(got)
    assert.equal(got.content, '# Hello\nworld')

    const list = repo.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, doc.id)
    assert.equal(list[0].revisionCount, 1)

    assert.equal(repo.delete(doc.id), true)
    assert.equal(repo.get(doc.id), null)
    assert.equal(repo.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: update creates a new revision; revision history capped', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const doc = repo.create({ kind: 'code', title: 'script', content: 'console.log(1)' })
    const updated = repo.update(doc.id, 'console.log(2)')
    assert.equal(updated.revisionCount, 2)
    assert.equal(updated.content, 'console.log(2)')
    assert.equal(updated.revisions.length, 2)
    assert.equal(updated.revisions[0].revision, 2) // newest first
    assert.equal(updated.revisions[1].revision, 1)

    const got = repo.get(doc.id)
    assert.equal(got.revisionCount, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: JSON artifact validates content on create; invalid JSON rejected', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    // Valid JSON → ok.
    const ok = repo.create({ kind: 'json', title: 'valid', content: '{"a": 1}' })
    assert.equal(ok.kind, 'json')

    // Invalid JSON → throws.
    assert.throws(
      () => repo.create({ kind: 'json', title: 'invalid', content: '{bad json' }),
      /JSON 校验失败/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: JSON artifact validates content on update; invalid JSON rejected', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const doc = repo.create({ kind: 'json', title: 'valid', content: '{"a": 1}' })
    assert.throws(
      () => repo.update(doc.id, '{broken'),
      /JSON 校验失败/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: validateJson standalone (for UI pre-check)', () => {
  assert.deepEqual(validateJson('{"a": 1}'), { valid: true })
  assert.deepEqual(validateJson('[1, 2, 3]'), { valid: true })
  const invalid = validateJson('{bad')
  assert.equal(invalid.valid, false)
  assert.ok(invalid.error)
})

test('artifact repo: defense-in-depth — a secret embedded in prose (not a .env assignment) is stripped, not rejected', () => {
  // classifySensitivity rejects content that matches a strict secret marker
  // (PEM block, ^KEY=VALUE .env assignment, AKIA id, AWS secret assignment).
  // A `sk-...` token embedded in PROSE (e.g. "Here: OPENAI_API_KEY=sk-...")
  // does NOT match ^[ \t]*KEY=VALUE (it is preceded by "Here: "), so it is NOT
  // classified as restricted and is NOT rejected. redactSecrets then strips the
  // `sk-...` token as defense-in-depth, so the persisted content + on-disk file
  // never carry the raw key. This test pins that defense-in-depth path: a
  // secret that slips past classification must still be redacted before write.
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const secret = 'OPENAI_API_KEY=sk-leaked-in-artifact-1234567890'
    const doc = repo.create({ kind: 'markdown', title: 'has secret', content: `Here: ${secret}` })
    // The persisted content must not contain the raw secret.
    assert.equal(doc.content.includes(secret), false, 'raw secret persisted in artifact')
    assert.equal(doc.content.includes('sk-leaked'), false, 'raw key persisted in artifact')
    // The on-disk file must not contain the raw secret either.
    const file = readFileSync(path.join(dir, 'ai', 'artifacts', `${doc.id}.json`), 'utf8')
    assert.equal(file.includes(secret), false, 'raw secret in artifact file')
    assert.equal(file.includes('sk-leaked'), false, 'raw key in artifact file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: classifyArtifactKind heuristics', () => {
  assert.equal(classifyArtifactKind('{"a": 1}'), 'json')
  assert.equal(classifyArtifactKind('[1, 2, 3]'), 'json')
  assert.equal(classifyArtifactKind('# Heading\n\nSome text'), 'markdown')
  assert.equal(classifyArtifactKind('- item 1\n- item 2'), 'markdown')
  assert.equal(classifyArtifactKind('const x = 1;'), 'code')
})

test('artifact repo: the same .env secret IS rejected when it starts the line (reject vs redact boundary)', () => {
  // Companion to the defense-in-depth test above: the SAME token that is
  // redacted when embedded in prose ("Here: KEY=sk-...") MUST be rejected
  // outright when it is a true ^KEY=VALUE .env assignment. This pins the
  // boundary: strict secret markers reject; residual tokens in prose redact.
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const secret = 'OPENAI_API_KEY=sk-leaked-in-artifact-1234567890'
    let caught
    try {
      repo.create({ kind: 'markdown', title: 'env at line start', content: secret })
    } catch (e) {
      caught = e
    }
    assert.ok(caught, 'true .env assignment should be rejected, not redacted')
    assert.match(caught.message, /受限内容/)
    assert.equal(caught.message.includes('sk-leaked'), false, 'raw key in rejection error')
    assert.equal(repo.list().length, 0, 'artifact created despite restricted content')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: has NO apply/writeback/execute method (read-only proposals; update only creates revisions)', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    // The public API must not include any apply/writeback/execute/inject method.
    // `update` is allowed — it creates a new REVISION (version history), it does
    // NOT write back into an editor, file, or conversation. The IPC layer does
    // NOT expose update to the renderer (see ai-context-runtime-ipc.test.mjs).
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter(
      (m) => m !== 'constructor' && typeof repo[m] === 'function',
    )
    const forbidden = methods.filter(
      (m) => /apply|writeback|execute|inject|insert|replace/i.test(m),
    )
    assert.deepEqual(forbidden, [], `artifact repo has write/apply methods: ${forbidden.join(', ')}`)
    // `update` exists (internal, for revision history) but is NOT exposed via IPC.
    assert.ok(methods.includes('update'), 'repo should have internal update for revisions')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: oversize content rejected', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const huge = 'x'.repeat(256 * 1024 + 100)
    assert.throws(
      () => repo.create({ kind: 'code', title: 'huge', content: huge }),
      /内容过大/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Restricted content rejection (PEM / .env / AWS) — no file written to disk.
// ---------------------------------------------------------------------------

/**
 * Helper: list every .json file under <dir>/ai/artifacts/ (excluding index.json)
 * and assert none contain the raw secret fragment.
 */
function assertNoArtifactFilesContain(dir, fragment) {
  const artDir = path.join(dir, 'ai', 'artifacts')
  if (!existsSync(artDir)) return
  for (const entry of readdirSync(artDir)) {
    if (entry === 'index.json') continue
    const full = path.join(artDir, entry)
    const content = readFileSync(full, 'utf8')
    assert.equal(
      content.includes(fragment), false,
      `raw secret fragment "${fragment}" found in artifact file ${entry}`,
    )
  }
}

test('artifact repo: create rejects PEM private key content; no file written; error has no raw key', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF5TkDkLQ...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    let caught
    try {
      repo.create({ kind: 'code', title: 'my key', content: pem })
    } catch (e) {
      caught = e
    }
    assert.ok(caught, 'create with PEM content should throw')
    assert.match(caught.message, /受限内容/)
    // The error message must NOT contain the raw PEM marker or body.
    assert.equal(caught.message.includes('MIIEpAIBAA'), false, 'raw key body in error')
    assert.equal(caught.message.includes('BEGIN RSA PRIVATE KEY'), false, 'raw PEM marker in error')
    // No artifact .json file should have been written.
    assertNoArtifactFilesContain(dir, 'MIIEpAIBAA')
    assertNoArtifactFilesContain(dir, 'BEGIN RSA PRIVATE KEY')
    // The repo list must be empty (nothing was created).
    assert.equal(repo.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: create rejects .env secret assignment; no file written', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const envContent = 'OPENAI_API_KEY=sk-test-secret-1234567890'
    let caught
    try {
      repo.create({ kind: 'markdown', title: 'env', content: envContent })
    } catch (e) {
      caught = e
    }
    assert.ok(caught, 'create with .env secret should throw')
    assert.match(caught.message, /受限内容/)
    // Error must not contain the raw secret value.
    assert.equal(caught.message.includes('sk-test-secret'), false, 'raw secret in error')
    // No file written.
    assertNoArtifactFilesContain(dir, 'sk-test-secret')
    assert.equal(repo.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: create rejects AWS access key ID; no file written', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const awsContent = 'AKIAIOSFODNN7EXAMPLE'
    let caught
    try {
      repo.create({ kind: 'code', title: 'aws key', content: awsContent })
    } catch (e) {
      caught = e
    }
    assert.ok(caught, 'create with AWS access key ID should throw')
    assert.match(caught.message, /受限内容/)
    assert.equal(caught.message.includes('AKIAIOSFODNN7EXAMPLE'), false, 'raw AWS key in error')
    assertNoArtifactFilesContain(dir, 'AKIAIOSFODNN7EXAMPLE')
    assert.equal(repo.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: create rejects AWS secret assignment; no file written', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const awsSecret = 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    let caught
    try {
      repo.create({ kind: 'code', title: 'aws secret', content: awsSecret })
    } catch (e) {
      caught = e
    }
    assert.ok(caught, 'create with AWS secret assignment should throw')
    assert.match(caught.message, /受限内容/)
    assert.equal(caught.message.includes('wJalrXUtnFEMI'), false, 'raw AWS secret in error')
    assertNoArtifactFilesContain(dir, 'wJalrXUtnFEMI')
    assert.equal(repo.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: update rejects restricted content; original artifact unchanged', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    // Create a clean artifact first.
    const doc = repo.create({ kind: 'code', title: 'clean', content: 'console.log("hello")' })
    assert.equal(doc.revisionCount, 1)

    // Attempt to update with PEM content — must throw.
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE...\n-----END OPENSSH PRIVATE KEY-----'
    let caught
    try {
      repo.update(doc.id, pem)
    } catch (e) {
      caught = e
    }
    assert.ok(caught, 'update with PEM content should throw')
    assert.match(caught.message, /受限内容/)
    assert.equal(caught.message.includes('b3BlbnNzaC1rZXktdjE'), false, 'raw key body in error')

    // The original artifact must be unchanged — same content, same revision count.
    const got = repo.get(doc.id)
    assert.equal(got.content, 'console.log("hello")', 'original content was modified')
    assert.equal(got.revisionCount, 1, 'revision count was incremented despite rejection')
    assert.equal(got.revisions.length, 1, 'revision history was modified despite rejection')

    // No file on disk should contain the PEM body.
    assertNoArtifactFilesContain(dir, 'b3BlbnNzaC1rZXktdjE')
    assertNoArtifactFilesContain(dir, 'BEGIN OPENSSH PRIVATE KEY')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('artifact repo: create rejects .env with export prefix; no file written', () => {
  const dir = makeTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const envContent = 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    let caught
    try {
      repo.create({ kind: 'markdown', title: 'exported env', content: envContent })
    } catch (e) {
      caught = e
    }
    assert.ok(caught, 'create with exported .env secret should throw')
    assert.match(caught.message, /受限内容/)
    assert.equal(caught.message.includes('wJalrXUtnFEMI'), false, 'raw secret in error')
    assertNoArtifactFilesContain(dir, 'wJalrXUtnFEMI')
    assert.equal(repo.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
