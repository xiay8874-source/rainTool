// P0-1 focused tests: transactional supplier + credential save.
//
// Contract: ai:supplier:save persists the credential FIRST; only if that
// succeeds is the supplier upserted. When safeStorage.isEncryptionAvailable()
// is false, the credential save returns { ok: false, reason:
// 'encryption-unavailable' } and the supplier is NOT written — no orphan
// supplier referencing a missing credential can exist.
//
// This test drives the IPC handler directly via the electron-stub's ipcMain
// scope (the same pattern ai-context-runtime-ipc.test.mjs uses), so it
// exercises the real ai-ipc.ts handler logic against the real repositories.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

register('./fixtures/electron-loader.mjs', import.meta.url)

const { AiCredentialVault } = await import('../dist-electron/ai-platform/ai-credential-vault.js')
const { AiModelProfileRepository } = await import('../dist-electron/ai-platform/ai-model-profile-repository.js')
const { AiSupplierRepository } = await import('../dist-electron/ai-platform/ai-supplier-repository.js')
const { AiRuntime } = await import('../dist-electron/ai-platform/ai-runtime.js')
const { AiContextVault } = await import('../dist-electron/ai-platform/ai-context-vault.js')
const { AiArtifactRepository } = await import('../dist-electron/ai-platform/ai-artifact-repository.js')
const { AiToolRegistry } = await import('../dist-electron/ai-platform/ai-tool-registry.js')
const { AiApprovalManager } = await import('../dist-electron/ai-platform/ai-approval-manager.js')
const { AiAuditLog } = await import('../dist-electron/ai-platform/ai-audit-log.js')
const { AiConversationRepository } = await import('../dist-electron/ai-platform/ai-conversation-repository.js')
const { AiMcpConfigRepository } = await import('../dist-electron/ai-platform/ai-mcp-config-repository.js')
const { AiMcpManager } = await import('../dist-electron/ai-platform/ai-mcp-manager.js')
const { registerAiIpc } = await import('../dist-electron/ai-platform/ai-ipc.js')
const {
  createIpcScope,
  setEncryptionAvailable,
} = await import('./fixtures/electron-stub.mjs')

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-atomic-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A no-op trusted-renderer assertion so the handlers run under test. */
const assertTrustedRenderer = () => {}

function buildIpc(dir) {
  const credentialVault = new AiCredentialVault(dir)
  const supplierRepository = new AiSupplierRepository(dir)
  const profileRepository = new AiModelProfileRepository(dir)
  profileRepository.setSupplierRepository({
    get: (id) => {
      const s = supplierRepository.get(id)
      return s
        ? { enabled: s.enabled, protocol: s.protocol, baseUrl: s.baseUrl, credentialKey: s.credentialKey }
        : null
    },
  })
  const conversationRepository = new AiConversationRepository(dir)
  const contextVault = new AiContextVault(dir)
  const artifactRepository = new AiArtifactRepository(dir)
  const toolRegistry = new AiToolRegistry()
  const approvalManager = new AiApprovalManager()
  const auditLog = new AiAuditLog(dir)
  const mcpConfigRepository = new AiMcpConfigRepository(dir)
  const mcpManager = new AiMcpManager({
    configRepository: mcpConfigRepository,
    resolveBundledLauncher: () => null,
    emit: () => {},
  })
  const runtime = new AiRuntime({
    providerRegistry: { streamChat: async () => ({ kind: 'completed', finalText: '' }) },
    conversationRepository,
    credentialVault,
    profileRepository,
    contextVault,
    artifactRepository,
    toolRegistry,
    approvalManager,
    auditLog,
    emit: () => {},
  })
  const scope = createIpcScope()
  scope.activate()
  registerAiIpc({
    mainWindow: () => null,
    assertTrustedRenderer,
    conversationRepository,
    profileRepository,
    supplierRepository,
    credentialVault,
    runtime,
    contextVault,
    artifactRepository,
    toolRegistry,
    approvalManager,
    auditLog,
    mcpManager,
  })
  return { scope, supplierRepository, profileRepository, credentialVault, deactivate: () => scope.deactivate() }
}

test('ai:supplier:delete cascades to every model owned by the supplier', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope, supplierRepository, profileRepository, deactivate } = buildIpc(dir)
    try {
      const supplier = supplierRepository.list()[0]
      profileRepository.upsert({
        providerId: supplier.providerId,
        displayName: 'Cascade model',
        model: 'cascade-model',
        baseUrl: supplier.baseUrl,
        credentialKey: supplier.credentialKey,
        supplierId: supplier.id,
        enabled: true,
        capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
      })
      assert.equal(profileRepository.list().length, 1)

      assert.equal(await scope._invoke('ai:supplier:delete', {}, supplier.id), true)
      assert.equal(supplierRepository.get(supplier.id), null)
      assert.equal(profileRepository.list().length, 0, 'no orphan model survives supplier deletion')
    } finally {
      deactivate()
    }
  } finally {
    cleanup()
  }
})

test('ai:supplier:save writes the supplier when the credential saves successfully', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const { scope, supplierRepository, credentialVault, deactivate } = buildIpc(dir)
    try {
      const result = await scope._invoke('ai:supplier:save', {}, {
        supplier: {
          displayName: 'My OpenAI',
          providerId: 'openai-compatible',
          protocol: 'openai-chat',
          baseUrl: 'https://api.openai.com/v1',
          credentialKey: 'cred_my_openai',
          enabled: true,
        },
        rawKey: 'sk-test-1234567890abcdef',
      })
      assert.equal(result.ok, true)
      assert.equal(result.supplier.displayName, 'My OpenAI')
      assert.equal(result.status.configured, true, 'credential marked configured')
      assert.equal(result.status.maskedPreview.includes('sk-test'), false, 'no raw key in status')
      // Persistence: the supplier is actually in the repository (not just
      // returned). This catches a handler that returns a supplier object
      // without calling upsert.
      const persisted = supplierRepository.list().find((s) => s.displayName === 'My OpenAI')
      assert.ok(persisted, 'supplier was persisted to the repository')
      assert.equal(persisted.credentialKey, 'cred_my_openai')
      // The credential is retrievable main-side (encrypted at rest).
      assert.equal(credentialVault.get('cred_my_openai'), 'sk-test-1234567890abcdef')
    } finally {
      deactivate()
    }
  } finally {
    cleanup()
  }
})

test('ai:supplier:save leaves NO orphan supplier when encryption is unavailable', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(false)
    const { scope, supplierRepository, deactivate } = buildIpc(dir)
    try {
      const beforeCount = supplierRepository.list().length // seeded TokenHub
      const result = await scope._invoke('ai:supplier:save', {}, {
        supplier: {
          displayName: 'Orphan',
          providerId: 'openai-compatible',
          protocol: 'openai-chat',
          baseUrl: 'https://api.openai.com/v1',
          credentialKey: 'cred_orphan',
          enabled: true,
        },
        rawKey: 'sk-test-1234567890abcdef',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'encryption-unavailable')
      // Critical assertion: no new supplier was written. The count is unchanged
      // (only the seeded TokenHub remains). No orphan referencing a credential
      // that was never persisted.
      assert.equal(
        supplierRepository.list().length,
        beforeCount,
        'no orphan supplier written when credential save failed',
      )
      assert.equal(
        supplierRepository.list().some((s) => s.displayName === 'Orphan'),
        false,
        'the failed-save supplier was not persisted',
      )
    } finally {
      deactivate()
    }
  } finally {
    setEncryptionAvailable(true)
    cleanup()
  }
})

test('ai:supplier:save without a rawKey creates the supplier with an empty credential slot (loopback TokenHub)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const { scope, deactivate } = buildIpc(dir)
    try {
      // Editing the seeded TokenHub supplier (loopback, no key) without a
      // rawKey: the supplier is upserted (folded into the seeded id), no
      // credential write attempted, no orphan.
      const result = await scope._invoke('ai:supplier:save', {}, {
        supplier: {
          id: 'supplier_tokenhub_default',
          displayName: 'TokenHub',
          providerId: 'openai-compatible',
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:15722/v1',
          credentialKey: 'cred_tokenhub_default',
          enabled: true,
        },
      })
      assert.equal(result.ok, true)
      assert.equal(result.supplier.id, 'supplier_tokenhub_default')
    } finally {
      deactivate()
    }
  } finally {
    cleanup()
  }
})

test('ai:supplier:save allocates a credentialKey for a new supplier that omits one', async () => {
  // Regression: the strict supplierInputSchema used to require
  // credentialKey.min(1), so the renderer passing '' (or omitting it) for a
  // new supplier failed Zod validation and the save threw. The save schema is
  // now relaxed (credentialKey optional); the handler allocates a fresh key.
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const { scope, supplierRepository, deactivate } = buildIpc(dir)
    try {
      const result = await scope._invoke('ai:supplier:save', {}, {
        supplier: {
          displayName: 'My Ollama',
          providerId: 'ollama',
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:11434/v1',
          // credentialKey intentionally OMITTED — handler must allocate.
          enabled: true,
        },
        // No rawKey — loopback Ollama needs no key.
      })
      assert.equal(result.ok, true)
      assert.equal(result.supplier.displayName, 'My Ollama')
      // The handler allocated a non-empty credentialKey starting with 'cred_'.
      assert.ok(result.supplier.credentialKey, 'allocated credentialKey is non-empty')
      assert.ok(
        result.supplier.credentialKey.startsWith('cred_'),
        `allocated key has cred_ prefix, got: ${result.supplier.credentialKey}`,
      )
      // Persisted with the allocated key.
      const persisted = supplierRepository.list().find((s) => s.displayName === 'My Ollama')
      assert.ok(persisted, 'new supplier was persisted')
      assert.equal(persisted.credentialKey, result.supplier.credentialKey)
    } finally {
      deactivate()
    }
  } finally {
    cleanup()
  }
})

test('ai:supplier:save folds a new TokenHub-URL supplier into the seeded id without orphaning a credential', async () => {
  // Regression: when a user creates a NEW supplier pointing at the TokenHub
  // default URL with a rawKey, the handler must resolve the CANONICAL
  // supplier id + credentialKey BEFORE writing the vault. The canonical key
  // for a TokenHub-URL fold is the seeded supplier's 'cred_tokenhub_default'.
  // The vault write lands there directly — no temp key is allocated, no
  // orphan is possible. The upsert fold branch preserves the target's
  // credentialKey (does not override it with the input's).
  const { dir, cleanup } = withTempDir()
  try {
    setEncryptionAvailable(true)
    const { scope, supplierRepository, credentialVault, deactivate } = buildIpc(dir)
    try {
      const result = await scope._invoke('ai:supplier:save', {}, {
        supplier: {
          displayName: 'TokenHub',
          providerId: 'openai-compatible',
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:15722/v1', // TokenHub default URL → folds
          // No credentialKey + no id → resolveCanonical returns the seeded
          // TokenHub supplier's canonical credentialKey ('cred_tokenhub_default').
          enabled: true,
        },
        rawKey: 'sk-tokenhub-fold-test',
      })
      assert.equal(result.ok, true)
      // Folded into the seeded TokenHub supplier id (not a new id).
      assert.equal(result.supplier.id, 'supplier_tokenhub_default')
      // The persisted supplier references the CANONICAL credentialKey, not a
      // temp key. This is the core assertion: the vault write and the supplier
      // reference the same key — no orphan.
      assert.equal(
        result.supplier.credentialKey,
        'cred_tokenhub_default',
        'folded supplier uses the canonical (seeded) credentialKey, not a temp key',
      )
      assert.equal(
        credentialVault.get('cred_tokenhub_default'),
        'sk-tokenhub-fold-test',
        'credential written to the canonical (TokenHub) key',
      )
      // The credential is configured at the canonical key.
      const tokenhubStatus = credentialVault.status('cred_tokenhub_default')
      assert.equal(tokenhubStatus.configured, true, 'TokenHub credential configured after fold')
      assert.equal(
        tokenhubStatus.maskedPreview.includes('sk-tokenhub-fold-test'),
        false,
        'no raw key in masked preview',
      )
      // Sanity: only one supplier exists (the seeded TokenHub, folded — no
      // duplicate created by the new-supplier save).
      assert.equal(supplierRepository.list().length, 1, 'no duplicate supplier created')
    } finally {
      deactivate()
    }
  } finally {
    cleanup()
  }
})
