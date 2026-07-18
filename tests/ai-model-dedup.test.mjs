// P0-1 focused tests: AiModelProfileRepository dedup + setEnabled.
//
// Covers the "添加模型" regression where every click appended a new profile
// (a real user hit 25 identical GLM-5.2 rows under TokenHub, flooding the AI
// dropdown). The fix has three layers, each tested here:
//
//   1. upsert dedup: a no-id upsert whose (supplierId, model) matches an
//      existing profile collapses onto it instead of creating a duplicate.
//      An explicit id always wins (never redirected to a twin).
//   2. setEnabled: atomic per-model enable toggle — touches ONLY enabled,
//      never rewrites model/displayName/baseUrl/credentialKey/supplierId.
//   3. readIndex load-time merge: profiles.json with duplicate (supplierId,
//      model) twins collapses to ONE canonical record (earliest createdAt
//      wins), and the discarded ids register as aliases so a historical
//      modelProfileId still resolves via get().
//
// Like ai-model-disabled-gating.test.mjs, this redirects bare `electron` to
// the controllable stub BEFORE importing the repos.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-dedup-'))
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

function baseInput(supplier, overrides = {}) {
  return {
    providerId: supplier.providerId,
    displayName: 'GLM-5.2',
    model: 'GLM-5.2',
    baseUrl: supplier.baseUrl,
    credentialKey: supplier.credentialKey,
    supplierId: supplier.id,
    enabled: true,
    capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
    ...overrides,
  }
}

test('no-id upsert with a (supplierId, model) twin collapses onto it (no duplicate)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    const first = profiles.upsert(baseInput(supplier))
    const second = profiles.upsert(baseInput(supplier))
    assert.equal(second.id, first.id, 'twin upsert returns the SAME id')
    assert.equal(profiles.list().length, 1, 'list does not grow')
    assert.equal(
      profiles.list().filter((p) => p.model === 'GLM-5.2').length,
      1,
      'exactly one GLM-5.2 profile',
    )
  } finally {
    cleanup()
  }
})

test('no-id upsert with a DIFFERENT model creates a new profile', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    profiles.upsert(baseInput(supplier, { model: 'GLM-5.2', displayName: 'GLM-5.2' }))
    profiles.upsert(baseInput(supplier, { model: 'gpt-4o-mini', displayName: 'gpt-4o-mini' }))
    assert.equal(profiles.list().length, 2, 'different model → new profile')
  } finally {
    cleanup()
  }
})

test('explicit id upsert always updates that id (never redirected to a twin)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    const first = profiles.upsert(baseInput(supplier))
    // A second profile with a DIFFERENT explicit id but the same model. This
    // must NOT collapse onto first — the caller passed an explicit id, so it
    // targets that specific profile. (Dedup only applies to no-id upserts.)
    const second = profiles.upsert(baseInput(supplier, { id: 'prof_explicit_second' }))
    assert.notEqual(second.id, first.id, 'explicit id is honored, not folded')
    assert.equal(second.id, 'prof_explicit_second')
    assert.equal(profiles.list().length, 2)
  } finally {
    cleanup()
  }
})

test('no-id upsert with a twin updates editable fields (displayName) without duplicating', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    const first = profiles.upsert(baseInput(supplier, { displayName: 'Original' }))
    // Re-add the same model with a new display name: collapses onto first,
    // updating its displayName.
    const updated = profiles.upsert(baseInput(supplier, { displayName: 'Renamed' }))
    assert.equal(updated.id, first.id)
    assert.equal(updated.displayName, 'Renamed')
    assert.equal(profiles.list().length, 1)
  } finally {
    cleanup()
  }
})

test('setEnabled toggles only enabled — never rewrites model/displayName/baseUrl', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    const created = profiles.upsert(baseInput(supplier, { displayName: 'My GLM' }))
    const before = profiles.get(created.id)
    assert.equal(before?.enabled, true)

    const toggled = profiles.setEnabled(created.id, false)
    assert.equal(toggled?.enabled, false)
    // No other field changed.
    assert.equal(toggled?.model, before?.model)
    assert.equal(toggled?.displayName, before?.displayName)
    assert.equal(toggled?.baseUrl, before?.baseUrl)
    assert.equal(toggled?.credentialKey, before?.credentialKey)
    assert.equal(toggled?.supplierId, before?.supplierId)
    assert.equal(toggled?.createdAt, before?.createdAt)
    // getEnabled now excludes it.
    assert.equal(profiles.getEnabled(created.id), null)

    // Re-enable.
    const onAgain = profiles.setEnabled(created.id, true)
    assert.equal(onAgain?.enabled, true)
    assert.equal(profiles.getEnabled(created.id)?.id, created.id)
  } finally {
    cleanup()
  }
})

test('setEnabled on an unknown id returns null (no throw)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { profiles } = wireRepositories(dir)
    assert.equal(profiles.setEnabled('prof_does_not_exist', false), null)
  } finally {
    cleanup()
  }
})

test('deleteBySupplier removes only models owned by that supplier', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers, profiles } = wireRepositories(dir)
    const firstSupplier = suppliers.list()[0]
    const secondSupplier = suppliers.upsert({
      displayName: 'Second local supplier',
      providerId: 'openai-compatible',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:19999/v1',
      credentialKey: 'cred_second',
      enabled: true,
    })
    profiles.upsert(baseInput(firstSupplier))
    profiles.upsert(baseInput(secondSupplier, { model: 'other-model', displayName: 'Other' }))

    assert.equal(profiles.deleteBySupplier(firstSupplier.id), 1)
    assert.equal(profiles.list().some((p) => p.supplierId === firstSupplier.id), false)
    assert.equal(profiles.list().some((p) => p.supplierId === secondSupplier.id), true)
  } finally {
    cleanup()
  }
})

test('readIndex collapses duplicate (supplierId, model) twins — earliest createdAt wins', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    // Hand-write a profiles.json with THREE identical (supplierId, model)
    // profiles — mirroring the real 25-copy regression. Each has a distinct id
    // and createdAt; the earliest should win as canonical.
    const aiDir = path.join(dir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    const profilesPath = path.join(aiDir, 'profiles.json')
    const earliest = Date.now() - 100_000
    writeFileSync(profilesPath, JSON.stringify({
      version: 2,
      profiles: [
        {
          id: 'prof_a', providerId: supplier.providerId, displayName: 'A',
          model: 'GLM-5.2', baseUrl: supplier.baseUrl,
          credentialKey: supplier.credentialKey, supplierId: supplier.id,
          enabled: true, capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
          createdAt: earliest, updatedAt: earliest,
        },
        {
          id: 'prof_b', providerId: supplier.providerId, displayName: 'B',
          model: 'GLM-5.2', baseUrl: supplier.baseUrl,
          credentialKey: supplier.credentialKey, supplierId: supplier.id,
          enabled: true, capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
          createdAt: earliest + 1_000, updatedAt: earliest + 1_000,
        },
        {
          id: 'prof_c', providerId: supplier.providerId, displayName: 'C',
          model: 'GLM-5.2', baseUrl: supplier.baseUrl,
          credentialKey: supplier.credentialKey, supplierId: supplier.id,
          enabled: true, capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
          createdAt: earliest + 2_000, updatedAt: earliest + 2_000,
        },
      ],
    }))

    const profiles = new AiModelProfileRepository(dir)
    const list = profiles.list().filter((p) => p.supplierId === supplier.id)
    assert.equal(list.length, 1, 'three twins collapse to one')
    assert.equal(list[0].id, 'prof_a', 'earliest createdAt is canonical')
    assert.equal(list[0].createdAt, earliest)
  } finally {
    cleanup()
  }
})

test('discarded duplicate ids resolve via get() as aliases (history safety)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { suppliers } = wireRepositories(dir)
    const supplier = suppliers.list()[0]
    const aiDir = path.join(dir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    const profilesPath = path.join(aiDir, 'profiles.json')
    const earliest = Date.now() - 100_000
    writeFileSync(profilesPath, JSON.stringify({
      version: 2,
      profiles: [
        {
          id: 'prof_keep', providerId: supplier.providerId, displayName: 'Keep',
          model: 'GLM-5.2', baseUrl: supplier.baseUrl,
          credentialKey: supplier.credentialKey, supplierId: supplier.id,
          enabled: true, capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
          createdAt: earliest, updatedAt: earliest,
        },
        {
          id: 'prof_drop', providerId: supplier.providerId, displayName: 'Drop',
          model: 'GLM-5.2', baseUrl: supplier.baseUrl,
          credentialKey: supplier.credentialKey, supplierId: supplier.id,
          enabled: true, capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
          createdAt: earliest + 5_000, updatedAt: earliest + 5_000,
        },
      ],
    }))

    const profiles = new AiModelProfileRepository(dir)
    // The dropped id is no longer in list(), but a historical modelProfileId
    // referencing it must still resolve — it aliases to the canonical id.
    const viaAlias = profiles.get('prof_drop')
    assert.equal(viaAlias?.id, 'prof_keep', 'aliased id redirects to canonical')
    assert.equal(viaAlias?.model, 'GLM-5.2')
    // The canonical id resolves directly too.
    assert.equal(profiles.get('prof_keep')?.id, 'prof_keep')
    // getEnabled on the alias also resolves (supplier enabled + profile enabled).
    assert.equal(profiles.getEnabled('prof_drop')?.id, 'prof_keep')
  } finally {
    cleanup()
  }
})

test('profiles with no supplierId are never merged (legacy v1 left as-is)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const aiDir = path.join(dir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    const profilesPath = path.join(aiDir, 'profiles.json')
    writeFileSync(profilesPath, JSON.stringify({
      version: 1,
      profiles: [
        {
          id: 'prof_legacy1', providerId: 'openai-compatible', displayName: 'L1',
          model: 'gpt-4o', credentialKey: 'cred_a',
          enabled: true, capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
          createdAt: 1, updatedAt: 1,
        },
        {
          id: 'prof_legacy2', providerId: 'openai-compatible', displayName: 'L2',
          model: 'gpt-4o', credentialKey: 'cred_a',
          enabled: true, capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
          createdAt: 2, updatedAt: 2,
        },
      ],
    }))
    const profiles = new AiModelProfileRepository(dir)
    // No supplierId → no dedup key → both kept (supplier migration handles
    // them later, assigning a supplierId at which point they'd dedup).
    assert.equal(profiles.list().length, 2, 'legacy profiles without supplierId are not merged')
  } finally {
    cleanup()
  }
})
