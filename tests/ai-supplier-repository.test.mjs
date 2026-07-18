// P0-1 focused tests: AiSupplierRepository.
//
// Covers:
//   - TokenHub default supplier seeded on first run (id + baseUrl + protocol).
//   - Legacy profile migration + dedup: profiles sharing (providerId, baseUrl,
//     credentialKey) collapse into ONE supplier; TokenHub-URL profiles fold
//     into the seeded TokenHub supplier (no duplicate).
//   - Enable/disable is atomic (rollback on write failure not needed here, but
//     the flag persists across reloads).
//   - Upsert folding a TokenHub-URL supplier into the seeded id prevents the
//     "add TokenHub again" duplicate the old modal allowed.
//
// Like ai-credential-vault.test.mjs, this redirects bare `electron` to the
// controllable stub BEFORE importing the repo (it imports safeStorage).

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

register('./fixtures/electron-loader.mjs', import.meta.url)

const { AiSupplierRepository } = await import(
  '../dist-electron/ai-platform/ai-supplier-repository.js'
)
const {
  TOKENHUB_DEFAULT_BASE_URL,
  TOKENHUB_DEFAULT_SUPPLIER_ID,
} = await import('../dist-electron/ai-platform/ai-types.js')

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-supplier-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('TokenHub default supplier is seeded on first run', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiSupplierRepository(dir)
    const suppliers = repo.list()
    assert.equal(suppliers.length, 1, 'exactly one default supplier seeded')
    const tokenhub = suppliers[0]
    assert.equal(tokenhub.id, TOKENHUB_DEFAULT_SUPPLIER_ID)
    assert.equal(tokenhub.baseUrl, TOKENHUB_DEFAULT_BASE_URL)
    assert.equal(tokenhub.protocol, 'openai-chat')
    assert.equal(tokenhub.enabled, true)
    // Seeding is idempotent: a second instance over the same dir does NOT add
    // a duplicate (the constructor only seeds when there are zero suppliers).
    const repo2 = new AiSupplierRepository(dir)
    assert.equal(repo2.list().length, 1)
  } finally {
    cleanup()
  }
})

test('legacy profiles sharing (providerId, baseUrl, credentialKey) dedup into one supplier', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiSupplierRepository(dir)
    // Three legacy profiles: two point at the same OpenAI endpoint + cred, one
    // at a different endpoint. The two sharing (providerId, baseUrl, credKey)
    // must collapse into ONE supplier; the third gets its own.
    const sid1 = repo.resolveSupplierForLegacyProfile({
      providerId: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credentialKey: 'cred_a',
    })
    const sid2 = repo.resolveSupplierForLegacyProfile({
      providerId: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credentialKey: 'cred_a',
    })
    const sid3 = repo.resolveSupplierForLegacyProfile({
      providerId: 'openai-compatible',
      baseUrl: 'https://api.openrouter.ai/v1',
      credentialKey: 'cred_b',
    })
    assert.equal(sid1, sid2, 'profiles sharing connection config share a supplier')
    assert.notEqual(sid1, sid3, 'different endpoint → different supplier')
    assert.equal(
      repo.list().length,
      3,
      'seeded TokenHub + two unique legacy suppliers (OpenAI deduped, OpenRouter)',
    )
  } finally {
    cleanup()
  }
})

test('TokenHub-URL legacy profiles fold into the seeded TokenHub supplier (no duplicate)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiSupplierRepository(dir)
    // A legacy profile pointing at the TokenHub default URL must fold into the
    // seeded TokenHub supplier — not create a second TokenHub-shaped supplier.
    const sid = repo.resolveSupplierForLegacyProfile({
      providerId: 'openai-compatible',
      baseUrl: TOKENHUB_DEFAULT_BASE_URL,
      credentialKey: 'cred_tokenhub_default',
    })
    assert.equal(sid, TOKENHUB_DEFAULT_SUPPLIER_ID, 'folded into seeded TokenHub id')
    // Only the seeded TokenHub supplier exists — no duplicate.
    assert.equal(repo.list().length, 1)
  } finally {
    cleanup()
  }
})

test('upsert folding a TokenHub-URL supplier into the seeded id prevents duplicates', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiSupplierRepository(dir)
    // Capture the seeded TokenHub supplier's canonical credentialKey BEFORE
    // the fold. The fold must preserve this key — the IPC handler writes the
    // vault to the canonical key (resolved via resolveCanonical), and the
    // upsert fold branch must NOT override it with the input's temp key.
    const seeded = repo.get(TOKENHUB_DEFAULT_SUPPLIER_ID)
    assert.equal(seeded.credentialKey, 'cred_tokenhub_default')
    // User "adds TokenHub again" via the settings page: upsert with the
    // TokenHub URL + a fresh credential. The repo must fold it into the seeded
    // TokenHub id rather than creating a second supplier.
    const folded = repo.upsert({
      displayName: 'TokenHub',
      providerId: 'openai-compatible',
      protocol: 'openai-chat',
      baseUrl: TOKENHUB_DEFAULT_BASE_URL,
      credentialKey: 'cred_user_new',
      enabled: true,
    })
    assert.equal(folded.id, TOKENHUB_DEFAULT_SUPPLIER_ID, 'folded into seeded id')
    assert.equal(repo.list().length, 1, 'still exactly one supplier (no duplicate)')
    // Critical: the fold preserved the seeded supplier's canonical
    // credentialKey. It did NOT override it with the input's 'cred_user_new'.
    assert.equal(
      folded.credentialKey,
      'cred_tokenhub_default',
      'fold preserved the canonical (seeded) credentialKey, not the input temp key',
    )
  } finally {
    cleanup()
  }
})

test('enable/disable persists across reloads', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiSupplierRepository(dir)
    const disabled = repo.setEnabled(TOKENHUB_DEFAULT_SUPPLIER_ID, false)
    assert.equal(disabled.enabled, false)
    assert.equal(repo.isEnabled(TOKENHUB_DEFAULT_SUPPLIER_ID), false)

    const reloaded = new AiSupplierRepository(dir)
    assert.equal(reloaded.isEnabled(TOKENHUB_DEFAULT_SUPPLIER_ID), false, 'disabled flag persisted')
    const reEnabled = reloaded.setEnabled(TOKENHUB_DEFAULT_SUPPLIER_ID, true)
    assert.equal(reEnabled.enabled, true)
  } finally {
    cleanup()
  }
})

test('setEnabled on a missing supplier returns null', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiSupplierRepository(dir)
    assert.equal(repo.setEnabled('supplier_does_not_exist', false), null)
  } finally {
    cleanup()
  }
})

test('delete removes a supplier', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiSupplierRepository(dir)
    const created = repo.upsert({
      displayName: 'My OpenAI',
      providerId: 'openai-compatible',
      protocol: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      credentialKey: 'cred_my',
      enabled: true,
    })
    assert.equal(repo.list().length, 2, 'seeded TokenHub + new supplier')
    assert.equal(repo.delete(created.id), true)
    assert.equal(repo.list().length, 1, 'back to just the seeded TokenHub')
    assert.equal(repo.get(created.id), null)
  } finally {
    cleanup()
  }
})

test('unsupported protocol is rejected', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiSupplierRepository(dir)
    assert.throws(() =>
      repo.upsert({
        displayName: 'Bad',
        providerId: 'openai-compatible',
        protocol: 'bogus-protocol',
        baseUrl: 'https://example.com',
        credentialKey: 'cred_x',
        enabled: true,
      }),
    )
  } finally {
    cleanup()
  }
})
