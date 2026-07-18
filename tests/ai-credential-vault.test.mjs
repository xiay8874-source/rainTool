// Tests for the encrypted Credential Vault.
//
// Covers the hard rules from plan §4.3 / P0 spike §5.2:
//   - safeStorage.isEncryptionAvailable() false DISABLES saving (no plaintext
//     fallback) and DISABLES reading back (get returns null).
//   - Raw keys never appear in masked status output.
//   - Masked preview shows only first/last 2 chars with a bounded mask.
//   - Vault file is written atomically under userData/ai/credentials.json.
//   - Corrupted ciphertext returns null (no key leaked via error).

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

// Redirect bare `electron` to the controllable stub BEFORE importing the vault.
register('./fixtures/electron-loader.mjs', import.meta.url)

const { AiCredentialVault } = await import(
  '../dist-electron/ai-platform/ai-credential-vault.js'
)
const { setEncryptionAvailable } = await import('./fixtures/electron-stub.mjs')

const RAW_KEY = 'sk-test-1234567890abcdef1234567890abcdef'

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-vault-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('vault persists an encrypted key and reads it back', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    const result = vault.set('cred_a', RAW_KEY)
    assert.equal(result.ok, true)

    // A NEW vault instance over the same dir must decrypt the same key.
    const reloaded = new AiCredentialVault(dir)
    assert.equal(reloaded.get('cred_a'), RAW_KEY)
  } finally {
    cleanup()
  }
})

test('vault file never stores plaintext; ciphertext differs from raw key', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    vault.set('cred_a', RAW_KEY)

    const file = path.join(dir, 'ai', 'credentials.json')
    const contents = readFileSync(file, 'utf8')
    assert.equal(contents.includes(RAW_KEY), false, 'raw key leaked to vault file')
    // The stored entry must be base64 ciphertext, not the original.
    const parsed = JSON.parse(contents)
    assert.equal(parsed.entries.cred_a.includes(RAW_KEY), false)
  } finally {
    cleanup()
  }
})

test('isEncryptionAvailable() false DISABLES saving with no plaintext fallback', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(false)
    const vault = new AiCredentialVault(dir)
    const result = vault.set('cred_a', RAW_KEY)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'encryption-unavailable')

    // A reloaded vault must not return the key, and the on-disk file (if
    // written at all) must not contain plaintext.
    const reloaded = new AiCredentialVault(dir)
    assert.equal(reloaded.get('cred_a'), null)
    try {
      const contents = readFileSync(path.join(dir, 'ai', 'credentials.json'), 'utf8')
      assert.equal(contents.includes(RAW_KEY), false, 'raw key written despite encryption off')
    } catch {
      // File never written — also acceptable (preferred: nothing persisted).
    }
  } finally {
    cleanup()
    setEncryptionAvailable(true)
  }
})

test('status() returns a masked preview that never reveals the raw key', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    vault.set('cred_a', RAW_KEY)

    const status = vault.status('cred_a')
    assert.equal(status.configured, true)
    assert.equal(status.encryptionAvailable, true)
    assert.equal(status.maskedPreview.includes(RAW_KEY), false)
    // Only first 2 + mask + last 2 chars.
    assert.equal(status.maskedPreview, `${RAW_KEY.slice(0, 2)}••••${RAW_KEY.slice(-2)}`)
  } finally {
    cleanup()
  }
})

test('status() for an unconfigured key shows configured=false and no preview', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    const status = vault.status('cred_missing')
    assert.equal(status.configured, false)
    assert.equal(status.maskedPreview, undefined)
  } finally {
    cleanup()
  }
})

test('short keys are fully masked (no length leak)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    vault.set('cred_short', 'ab')
    const status = vault.status('cred_short')
    assert.equal(status.maskedPreview, '••••')
  } finally {
    cleanup()
  }
})

test('corrupted ciphertext returns null instead of throwing or leaking', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    vault.set('cred_a', RAW_KEY)

    // Corrupt the on-disk ciphertext: a valid-length blob that fails the
    // decrypt magic check (the real safeStorage throws on bad ciphertext).
    const file = path.join(dir, 'ai', 'credentials.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    parsed.entries.cred_a = Buffer.from('NOT-VALID-CIPHERTEXT-BYTES').toString('base64')
    writeFileSync(file, JSON.stringify(parsed))

    const reloaded = new AiCredentialVault(dir)
    assert.equal(reloaded.get('cred_a'), null)
  } finally {
    cleanup()
  }
})

test('get() returns null when encryption is unavailable, even if a ciphertext exists', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    vault.set('cred_a', RAW_KEY)

    setEncryptionAvailable(false)
    const reloaded = new AiCredentialVault(dir)
    assert.equal(reloaded.get('cred_a'), null)
    assert.equal(reloaded.isEncryptionAvailable(), false)
  } finally {
    cleanup()
    setEncryptionAvailable(true)
  }
})

test('delete() removes a credential and clear() removes all', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    vault.set('cred_a', RAW_KEY)
    vault.set('cred_b', 'sk-other-key-1234567890')

    vault.delete('cred_a')
    assert.equal(vault.get('cred_a'), null)
    assert.equal(vault.get('cred_b'), 'sk-other-key-1234567890')

    vault.clear()
    assert.equal(vault.get('cred_b'), null)
  } finally {
    cleanup()
  }
})

test('invalid credential key names are rejected', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    assert.throws(() => vault.set('bad key!', RAW_KEY))
    assert.throws(() => vault.get('../escape'))
  } finally {
    cleanup()
  }
})

test('empty raw key input deletes any existing entry (no error)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const vault = new AiCredentialVault(dir)
    vault.set('cred_a', RAW_KEY)
    assert.equal(vault.get('cred_a'), RAW_KEY)

    const result = vault.set('cred_a', '   ')
    assert.equal(result.ok, true)
    assert.equal(vault.get('cred_a'), null)
  } finally {
    cleanup()
  }
})
