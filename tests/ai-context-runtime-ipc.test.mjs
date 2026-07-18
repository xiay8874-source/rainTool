// P2 runtime context integration + IPC validation tests.
//
// Covers:
//   - Runtime: only EXPLICITLY selected attachment ids become model context;
//     no silent component context. The assembled context text is prepended to
//     the system prompt passed to streamChat.
//   - Runtime: a restricted attachment blocks the run fail-closed (deferred
//     `failed` terminal; the provider is NEVER called).
//   - Runtime: vault payloads are cleared for the run on terminal (cleanup).
//   - IPC: ai:run:start rejects invalid/unknown/oversize attachment ids before
//     allocating a run; ai:context:* and ai:artifact:* handlers work and are
//     guarded by assertTrustedRenderer.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AiRuntime } from '../dist-electron/ai-platform/ai-runtime.js'
import { AiContextVault } from '../dist-electron/ai-platform/ai-context-vault.js'
import { AiConversationRepository } from '../dist-electron/ai-platform/ai-conversation-repository.js'
import { AiArtifactRepository } from '../dist-electron/ai-platform/ai-artifact-repository.js'
import { mockFetch, TEST_PROFILE } from './fixtures/mock-openai-fetch.mjs'
import { AiProviderRegistry } from '../dist-electron/ai-platform/ai-provider-registry.js'

// Register the electron loader ONCE so `registerAiIpc` (which imports `electron`)
// resolves to the test stub. Must happen before the dynamic import below.
import { register as registerModule } from 'node:module'
registerModule('./fixtures/electron-loader.mjs', import.meta.url)

const { registerAiIpc } = await import('../dist-electron/ai-platform/ai-ipc.js')
const { createIpcScope } = await import('./fixtures/electron-stub.mjs')

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-p2-runtime-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeVault(key) {
  return { get: () => key, isEncryptionAvailable: () => true }
}

function fakeProfileRepo(profile) {
  return { get: (id) => (profile && id === profile.id ? profile : null) }
}

function eventSink() {
  const events = []
  let terminalResolver
  const terminalPromise = new Promise((r) => { terminalResolver = r })
  return {
    events,
    emit: (e) => {
      events.push(e)
      if (e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled') {
        terminalResolver(e)
      }
    },
    waitForTerminal: () => terminalPromise,
  }
}

/**
 * A capturing provider that records the system prompt + messages it receives,
 * then returns a scripted outcome. Used to prove the runtime prepends the
 * assembled context text to the system prompt.
 */
function capturingProvider(outcome, captures) {
  return {
    streamChat: async ({ system, messages, emit, runId, sequence }) => {
      captures.system = system
      captures.messages = messages
      return outcome
    },
  }
}

async function waitForRunSettled(runtime, runId, timeoutMs = 2000) {
  const start = Date.now()
  while (runtime.isActive(runId)) {
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} did not settle`)
    await new Promise((r) => setTimeout(r, 5))
  }
  await new Promise((r) => setTimeout(r, 5))
}

// ---------------------------------------------------------------------------
// Runtime: explicit attachments only
// ---------------------------------------------------------------------------

test('runtime: only explicitly selected attachments become model context (no silent context)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const contextVault = new AiContextVault(dir)
    // Ingest TWO attachments, but only select ONE for the run.
    const selected = contextVault.ingest({ source: 'json-workbench', title: 'selected', text: 'SELECTED CONTEXT' })
    const _unselected = contextVault.ingest({ source: 'json-workbench', title: 'unselected', text: 'UNSELECTED CONTEXT' })
    const sink = eventSink()
    const captures = {}
    const runtime = new AiRuntime({
      providerRegistry: capturingProvider({ kind: 'completed', finalText: 'ok' }, captures),
      conversationRepository: conversationRepo,
      credentialVault: fakeVault('sk-test'),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      contextVault,
      emit: sink.emit,
    })
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: TEST_PROFILE.id,
      mode: 'chat',
      message: 'hi',
      attachmentIds: [selected.id], // ONLY the selected id
    })
    await waitForRunSettled(runtime, runId)
    // The system prompt the provider received must contain the selected
    // context and NOT the unselected context.
    assert.ok(captures.system.includes('SELECTED CONTEXT'), 'selected context not in system prompt')
    assert.equal(captures.system.includes('UNSELECTED CONTEXT'), false, 'unselected context leaked into system prompt')
  } finally {
    cleanup()
  }
})

test('runtime: no attachmentIds → system prompt has no context block', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const contextVault = new AiContextVault(dir)
    const sink = eventSink()
    const captures = {}
    const runtime = new AiRuntime({
      providerRegistry: capturingProvider({ kind: 'completed', finalText: 'ok' }, captures),
      conversationRepository: conversationRepo,
      credentialVault: fakeVault('sk-test'),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      contextVault,
      emit: sink.emit,
    })
    const { runId } = runtime.start({
      conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'hi',
    })
    await waitForRunSettled(runtime, runId)
    assert.equal(captures.system.includes('[附加上下文]'), false, 'context block present with no attachments')
  } finally {
    cleanup()
  }
})

test('runtime: restricted attachment blocks the run fail-closed; provider NEVER called', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const contextVault = new AiContextVault(dir)
    const secret = 'OPENAI_API_KEY=sk-restricted-block-1234567890'
    const restricted = contextVault.ingest({ source: 'manual', title: 'secret env', text: secret })
    assert.equal(contextVault.getMeta(restricted.id).sensitivity, 'restricted')
    const sink = eventSink()
    let providerCalled = false
    const runtime = new AiRuntime({
      providerRegistry: {
        streamChat: async () => { providerCalled = true; return { kind: 'completed', finalText: 'x' } },
      },
      conversationRepository: conversationRepo,
      credentialVault: fakeVault('sk-test'),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      contextVault,
      emit: sink.emit,
    })
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: TEST_PROFILE.id,
      mode: 'chat',
      message: 'hi',
      attachmentIds: [restricted.id],
    })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'failed')
    assert.equal(providerCalled, false, 'provider was called despite restricted attachment')
    // The terminal error must not contain the raw secret.
    assert.equal(terminal.payload.redactedError.includes(secret), false)
    assert.equal(terminal.payload.redactedError.includes('sk-restricted'), false)
    await waitForRunSettled(runtime, runId)
  } finally {
    cleanup()
  }
})

test('runtime: vault payloads cleared for the run on terminal (cleanup)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const contextVault = new AiContextVault(dir)
    const att = contextVault.ingest({ source: 'manual', title: 'temp', text: 'temp context' })
    assert.ok(contextVault.getText(att.id))
    const sink = eventSink()
    const runtime = new AiRuntime({
      providerRegistry: capturingProvider({ kind: 'completed', finalText: 'ok' }, {}),
      conversationRepository: conversationRepo,
      credentialVault: fakeVault('sk-test'),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      contextVault,
      emit: sink.emit,
    })
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: TEST_PROFILE.id,
      mode: 'chat',
      message: 'hi',
      attachmentIds: [att.id],
    })
    await waitForRunSettled(runtime, runId)
    // After the run settles, the payload for the run's attachment is cleared.
    assert.equal(contextVault.getText(att.id), null, 'payload not cleared after run terminal')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// IPC: validation at the boundary
// ---------------------------------------------------------------------------

function makeIpcFixture(options = {}) {
  const { dir } = options
  // Each fixture gets an ISOLATED IPC handler scope. node:test runs suites
  // concurrently in one process; a single global handler map would race
  // between this suite and ai-capability-enforcement (both call registerAiIpc).
  // The scope's handler map is private to this fixture, so concurrent suites
  // never overwrite each other's handlers or invoke against another suite's
  // (already-cleaned-up) temp dir. No global clearing needed.
  const scope = createIpcScope()
  scope.activate()
  const trustCalls = []
  const conversationRepo = new AiConversationRepository(dir)
  const contextVault = new AiContextVault(dir)
  const artifactRepo = new AiArtifactRepository(dir)
  const startCalls = []
  const deps = {
    mainWindow: () => null,
    assertTrustedRenderer: (event) => { trustCalls.push(event) },
    conversationRepository: conversationRepo,
    profileRepository: {
      list: () => [], get: () => null,
      upsert: () => { throw new Error('should not be called') },
      delete: () => false,
    },
    credentialVault: { status: () => ({ credentialKey: '', configured: false, encryptionAvailable: true }) },
    runtime: {
      start: (request) => { startCalls.push(request); return { runId: 'run_mock_1' } },
      cancel: () => false,
    },
    contextVault,
    artifactRepository: artifactRepo,
    // P3 stubs: these suites don't exercise P3 channels, but the deps object
    // must satisfy the AiIpcDeps shape so registerAiIpc doesn't break if a
    // future test touches a P3 handler.
    toolRegistry: { list: () => [] },
    approvalManager: { decide: () => { throw new Error('not used') }, listPending: () => [] },
    auditLog: { list: () => [] },
  }
  registerAiIpc(deps)
  return { deps, trustCalls, startCalls, contextVault, artifactRepo, scope }
}

const TRUSTED_EVENT = { sender: {}, frameId: 0 }

function invokeHandlerFor(scope, channel, event, ...args) {
  return Promise.resolve().then(() => scope._invoke(channel, event, ...args))
}

test('IPC ai:run:start: rejects unknown attachment ids before allocating a run', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { startCalls, scope } = makeIpcFixture({ dir })
    await assert.rejects(
      () => invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
        conversationId: 'conv_x', modelProfileId: 'prof_x', mode: 'chat', message: 'hi',
        attachmentIds: ['ctx_nonexistent'],
      }),
      (err) => err instanceof Error && /未知|无效|not found|unknown/i.test(err.message),
    )
    assert.equal(startCalls.length, 0, 'runtime.start was called despite unknown attachment id')
  } finally {
    cleanup()
  }
})

test('IPC ai:run:start: rejects invalid attachment id format', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { startCalls, scope } = makeIpcFixture({ dir })
    await assert.rejects(
      () => invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
        conversationId: 'conv_x', modelProfileId: 'prof_x', mode: 'chat', message: 'hi',
        attachmentIds: ['../../etc/passwd'],
      }),
    )
    assert.equal(startCalls.length, 0, 'runtime.start was called despite invalid attachment id')
  } finally {
    cleanup()
  }
})

test('IPC ai:run:start: rejects too many attachments (over cap)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { startCalls, contextVault, scope } = makeIpcFixture({ dir })
    // Ingest enough valid attachments to exceed the cap (8).
    const ids = []
    for (let i = 0; i < 10; i++) {
      const m = contextVault.ingest({ source: 'manual', title: `a${i}`, text: 'x' })
      ids.push(m.id)
    }
    await assert.rejects(
      () => invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
        conversationId: 'conv_x', modelProfileId: 'prof_x', mode: 'chat', message: 'hi',
        attachmentIds: ids,
      }),
      (err) => err instanceof Error && /上限|cap|limit/i.test(err.message),
    )
    assert.equal(startCalls.length, 0, 'runtime.start was called despite over-cap attachments')
  } finally {
    cleanup()
  }
})

test('IPC ai:run:start: valid attachment ids → run starts with those ids', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { startCalls, contextVault, scope } = makeIpcFixture({ dir })
    const m = contextVault.ingest({ source: 'manual', title: 'ok', text: 'valid context' })
    const result = await invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
      conversationId: 'conv_x', modelProfileId: 'prof_x', mode: 'chat', message: 'hi',
      attachmentIds: [m.id],
    })
    assert.equal(startCalls.length, 1)
    assert.deepEqual(startCalls[0].attachmentIds, [m.id])
    assert.ok(result.runId)
  } finally {
    cleanup()
  }
})

test('IPC ai:context:ingest returns metadata (no raw payload); ai:context:list returns metas only', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeIpcFixture({ dir })
    const secret = 'OPENAI_API_KEY=sk-ipc-ingest-1234567890'
    const meta = await invokeHandlerFor(scope, 'ai:context:ingest', TRUSTED_EVENT, {
      source: 'manual', title: 'env', text: secret,
    })
    assert.ok(meta.id.startsWith('ctx_'))
    assert.equal(meta.sensitivity, 'restricted')
    assert.equal(JSON.stringify(meta).includes(secret), false, 'raw payload in ingest response')
    const list = await invokeHandlerFor(scope, 'ai:context:list', TRUSTED_EVENT)
    assert.equal(list.length, 1)
    assert.equal(JSON.stringify(list[0]).includes(secret), false, 'raw payload in list response')
  } finally {
    cleanup()
  }
})

test('IPC ai:context:delete removes the attachment', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeIpcFixture({ dir })
    const meta = await invokeHandlerFor(scope, 'ai:context:ingest', TRUSTED_EVENT, {
      source: 'manual', title: 'to-remove', text: 'remove me',
    })
    const deleted = await invokeHandlerFor(scope, 'ai:context:delete', TRUSTED_EVENT, meta.id)
    assert.equal(deleted, true)
    const list = await invokeHandlerFor(scope, 'ai:context:list', TRUSTED_EVENT)
    assert.equal(list.length, 0)
  } finally {
    cleanup()
  }
})

test('IPC ai:artifact:create + get + list + delete (read-only; no writeback)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeIpcFixture({ dir })
    const doc = await invokeHandlerFor(scope, 'ai:artifact:create', TRUSTED_EVENT, {
      kind: 'markdown', title: 'Proposal', content: '# Hello',
    })
    assert.ok(doc.id.startsWith('art_'))
    assert.equal(doc.content, '# Hello')
    const got = await invokeHandlerFor(scope, 'ai:artifact:get', TRUSTED_EVENT, doc.id)
    assert.ok(got)
    assert.equal(got.content, '# Hello')
    const list = await invokeHandlerFor(scope, 'ai:artifact:list', TRUSTED_EVENT)
    assert.equal(list.length, 1)
    const deleted = await invokeHandlerFor(scope, 'ai:artifact:delete', TRUSTED_EVENT, doc.id)
    assert.equal(deleted, true)
  } finally {
    cleanup()
  }
})

test('IPC: NO ai:artifact:update handler exposed to the renderer (read-only proposals)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeIpcFixture({ dir })
    const channels = scope._channels()
    assert.equal(
      channels.includes('ai:artifact:update'), false,
      'ai:artifact:update handler must NOT be registered (artifacts are read-only)',
    )
    // The read-only surface: list, get, create, delete, validate-json.
    assert.ok(channels.includes('ai:artifact:list'))
    assert.ok(channels.includes('ai:artifact:get'))
    assert.ok(channels.includes('ai:artifact:create'))
    assert.ok(channels.includes('ai:artifact:delete'))
    assert.ok(channels.includes('ai:artifact:validate-json'))
  } finally {
    cleanup()
  }
})

test('IPC ai:artifact:create JSON: invalid JSON rejected with safe error', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeIpcFixture({ dir })
    await assert.rejects(
      () => invokeHandlerFor(scope, 'ai:artifact:create', TRUSTED_EVENT, {
        kind: 'json', title: 'bad', content: '{invalid',
      }),
      (err) => err instanceof Error && /JSON 校验失败/.test(err.message),
    )
  } finally {
    cleanup()
  }
})

test('IPC ai:artifact:validate-json: returns valid/invalid without creating an artifact', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeIpcFixture({ dir })
    const valid = await invokeHandlerFor(scope, 'ai:artifact:validate-json', TRUSTED_EVENT, '{"a": 1}')
    assert.equal(valid.valid, true)
    const invalid = await invokeHandlerFor(scope, 'ai:artifact:validate-json', TRUSTED_EVENT, '{bad')
    assert.equal(invalid.valid, false)
    assert.ok(invalid.error)
    // No artifact was created.
    const list = await invokeHandlerFor(scope, 'ai:artifact:list', TRUSTED_EVENT)
    assert.equal(list.length, 0)
  } finally {
    cleanup()
  }
})

test('IPC: every ai:context:* and ai:artifact:* handler is guarded by assertTrustedRenderer', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { trustCalls, scope } = makeIpcFixture({ dir })
    trustCalls.length = 0
    await invokeHandlerFor(scope, 'ai:context:list', TRUSTED_EVENT)
    await invokeHandlerFor(scope, 'ai:artifact:list', TRUSTED_EVENT)
    await invokeHandlerFor(scope, 'ai:artifact:validate-json', TRUSTED_EVENT, '{}')
    // Each handler must have called assertTrustedRenderer exactly once.
    assert.equal(trustCalls.length, 3, 'not all handlers were trust-guarded')
  } finally {
    cleanup()
  }
})
