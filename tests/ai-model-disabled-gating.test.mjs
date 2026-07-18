// P0-1 focused tests: disabled-model gating.
//
// A model is usable for a NEW run only when BOTH:
//   - the profile's own `enabled` flag is true, AND
//   - the profile's supplier (if linked) is enabled.
//
// The runtime's runLoop + proposeCommitMessage use profileRepository.getEnabled
// (not get). The AI assistant dropdown uses listEnabled. This test verifies
// both exclusion paths so a disabled model can never be used by the AI
// assistant or Git AI, even though its conversation history is preserved.
//
// Like ai-credential-vault.test.mjs, this redirects bare `electron` to the
// controllable stub BEFORE importing the repos.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

register('./fixtures/electron-loader.mjs', import.meta.url)

const { AiModelProfileRepository } = await import(
  '../dist-electron/ai-platform/ai-model-profile-repository.js'
)
const { AiSupplierRepository } = await import(
  '../dist-electron/ai-platform/ai-supplier-repository.js'
)

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-gating-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function wireRepositories(dir) {
  const suppliers = new AiSupplierRepository(dir)
  const profiles = new AiModelProfileRepository(dir)
  profiles.setSupplierRepository({
    get: (id) => {
      const s = suppliers.get(id)
      return s
        ? { enabled: s.enabled, protocol: s.protocol, baseUrl: s.baseUrl, credentialKey: s.credentialKey }
        : null
    },
  })
  return { suppliers, profiles }
}

test('getEnabled returns null for a profile whose own enabled flag is false', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const supplier = suppliers.list()[0] // seeded TokenHub
    const p = profiles.upsert({
      providerId: supplier.providerId,
      displayName: 'GLM-5.2',
      model: 'GLM-5.2',
      baseUrl: supplier.baseUrl,
      credentialKey: supplier.credentialKey,
      supplierId: supplier.id,
      enabled: true,
    })
    assert.equal(profiles.getEnabled(p.id)?.id, p.id, 'enabled profile is usable')
    // Disable the profile itself.
    const disabled = profiles.upsert({
      id: p.id,
      providerId: p.providerId,
      displayName: p.displayName,
      model: p.model,
      baseUrl: p.baseUrl,
      credentialKey: p.credentialKey,
      supplierId: p.supplierId,
      enabled: false,
      capabilities: p.capabilities,
    })
    assert.equal(disabled.enabled, false)
    assert.equal(profiles.getEnabled(p.id), null, 'disabled profile is NOT usable for new runs')
    // `get` still returns it so conversation history can resolve the name.
    assert.equal(profiles.get(p.id)?.id, p.id, 'disabled profile still resolvable for history')
  } finally {
    cleanup()
  }
})

test('getEnabled returns null when the profile\'s supplier is disabled', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    const p = profiles.upsert({
      providerId: supplier.providerId,
      displayName: 'GLM-5.2',
      model: 'GLM-5.2',
      baseUrl: supplier.baseUrl,
      credentialKey: supplier.credentialKey,
      supplierId: supplier.id,
      enabled: true,
    })
    // Profile itself is enabled; supplier is enabled → usable.
    assert.equal(profiles.getEnabled(p.id)?.id, p.id)
    // Disable the SUPPLIER. The profile's own flag is still true, but because
    // the supplier is disabled, getEnabled must return null — a disabled
    // supplier excludes ALL its models.
    suppliers.setEnabled(supplier.id, false)
    assert.equal(profiles.getEnabled(p.id), null, 'disabled supplier excludes its models')
    // listEnabled drops it too.
    assert.equal(
      profiles.listEnabled().some((x) => x.id === p.id),
      false,
      'disabled supplier models absent from listEnabled',
    )
    // Re-enable the supplier → model is usable again.
    suppliers.setEnabled(supplier.id, true)
    assert.equal(profiles.getEnabled(p.id)?.id, p.id, 're-enabling supplier restores the model')
  } finally {
    cleanup()
  }
})

test('listEnabled excludes disabled profiles AND disabled-supplier profiles', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    // Two models under the TokenHub supplier: one enabled, one disabled.
    const enabledModel = profiles.upsert({
      providerId: supplier.providerId,
      displayName: 'GLM-5.2',
      model: 'GLM-5.2',
      baseUrl: supplier.baseUrl,
      credentialKey: supplier.credentialKey,
      supplierId: supplier.id,
      enabled: true,
    })
    const disabledModel = profiles.upsert({
      providerId: supplier.providerId,
      displayName: 'Legacy',
      model: 'old-model',
      baseUrl: supplier.baseUrl,
      credentialKey: supplier.credentialKey,
      supplierId: supplier.id,
      enabled: false,
    })
    const enabled = profiles.listEnabled()
    assert.equal(enabled.some((p) => p.id === enabledModel.id), true, 'enabled model listed')
    assert.equal(enabled.some((p) => p.id === disabledModel.id), false, 'disabled model excluded')
    // Now disable the supplier: even the enabled model drops out.
    suppliers.setEnabled(supplier.id, false)
    const afterSupplierDisable = profiles.listEnabled()
    assert.equal(afterSupplierDisable.some((p) => p.id === enabledModel.id), false, 'enabled model excluded when supplier disabled')
  } finally {
    cleanup()
  }
})

test('profiles with no supplierId work standalone (legacy, not yet migrated)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    // A profile repo with NO supplier repository wired: behaves like legacy.
    const profiles = new AiModelProfileRepository(dir)
    const p = profiles.upsert({
      providerId: 'openai-compatible',
      displayName: 'Standalone',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      credentialKey: 'cred_standalone',
      enabled: true,
    })
    assert.equal(profiles.getEnabled(p.id)?.id, p.id)
    assert.equal(profiles.listEnabled().length, 1)
  } finally {
    cleanup()
  }
})
