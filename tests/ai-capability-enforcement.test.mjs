// Regression tests for P1 capability enforcement at the main-process boundary.
//
// The UI only supports openai-compatible and ollama providers, and the runtime
// only implements the `chat` mode. These tests prove the boundary rejects
// unsupported provider ids and non-chat modes with explicit safe errors, and
// that legacy persisted profiles with an unsupported provider do not load.
//
// Covers:
//   - Profile repo upsert rejects anthropic/google with an explicit error.
//   - Legacy profiles.json with an unsupported providerId is filtered on load.
//   - Runtime.start rejects non-chat modes (agent/assistant) with a deferred
//     `failed` terminal carrying an explicit redactedError.
//   - The IPC mode-check logic (P1_SUPPORTED_RUN_MODES) rejects non-chat modes
//     synchronously, mirroring the ai:run:start + ai:conversation:create guards.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AiModelProfileRepository, P1_SUPPORTED_PROVIDERS } from '../dist-electron/ai-platform/ai-model-profile-repository.js'
import { AiRuntime } from '../dist-electron/ai-platform/ai-runtime.js'
import { AiConversationRepository } from '../dist-electron/ai-platform/ai-conversation-repository.js'
import { P1_SUPPORTED_RUN_MODES } from '../dist-electron/ai-platform/ai-types.js'
import { mockFetch, TEST_PROFILE } from './fixtures/mock-openai-fetch.mjs'

const RAW_KEY = 'sk-capability-test-key-1234567890'

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-cap-'))
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
      if (e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled') terminalResolver(e)
    },
    waitForTerminal: () => terminalPromise,
  }
}
function terminalTypes(events) {
  return events.filter((e) => e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled')
}

// ---------------------------------------------------------------------------
// Provider capability enforcement at the profile repository
// ---------------------------------------------------------------------------

test('P1_SUPPORTED_PROVIDERS contains only openai-compatible and ollama', () => {
  assert.ok(P1_SUPPORTED_PROVIDERS.has('openai-compatible'))
  assert.ok(P1_SUPPORTED_PROVIDERS.has('ollama'))
  assert.equal(P1_SUPPORTED_PROVIDERS.has('anthropic'), false)
  assert.equal(P1_SUPPORTED_PROVIDERS.has('google'), false)
})

test('profile repo upsert rejects anthropic with an explicit safe error', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiModelProfileRepository(dir)
    assert.throws(
      () => repo.upsert({
        providerId: 'anthropic',
        displayName: 'Claude',
        model: 'claude-3',
        credentialKey: 'cred_a',
      }),
      (err) => err instanceof Error && /P1 暂不支持该 provider.*anthropic/.test(err.message),
      'anthropic should be rejected with an explicit P1 error',
    )
  } finally {
    cleanup()
  }
})

test('profile repo upsert rejects google with an explicit safe error', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiModelProfileRepository(dir)
    assert.throws(
      () => repo.upsert({
        providerId: 'google',
        displayName: 'Gemini',
        model: 'gemini-1.5',
        credentialKey: 'cred_a',
      }),
      (err) => err instanceof Error && /P1 暂不支持该 provider.*google/.test(err.message),
    )
  } finally {
    cleanup()
  }
})

test('profile repo upsert accepts openai-compatible and ollama', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiModelProfileRepository(dir)
    const a = repo.upsert({
      providerId: 'openai-compatible',
      displayName: 'OpenAI',
      model: 'gpt-4o',
      credentialKey: 'cred_a',
    })
    assert.equal(a.providerId, 'openai-compatible')
    const b = repo.upsert({
      providerId: 'ollama',
      displayName: 'Ollama',
      model: 'llama3',
      credentialKey: 'cred_b',
    })
    assert.equal(b.providerId, 'ollama')
    assert.equal(repo.list().length, 2)
  } finally {
    cleanup()
  }
})

test('legacy profiles.json with an unsupported providerId is filtered on load (never reaches UI)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    // Hand-write a profiles.json mixing supported + unsupported providers.
    const aiDir = path.join(dir, 'ai')
    mkdirSync(aiDir, { recursive: true })
    writeFileSync(path.join(aiDir, 'profiles.json'), JSON.stringify({
      version: 1,
      profiles: [
        { id: 'prof_ok', providerId: 'openai-compatible', displayName: 'OK', model: 'gpt-4o', credentialKey: 'cred_ok', capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false }, createdAt: 0, updatedAt: 0 },
        { id: 'prof_anthropic', providerId: 'anthropic', displayName: 'Legacy Claude', model: 'claude-3', credentialKey: 'cred_legacy', capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false }, createdAt: 0, updatedAt: 0 },
        { id: 'prof_google', providerId: 'google', displayName: 'Legacy Gemini', model: 'gemini-1.5', credentialKey: 'cred_legacy2', capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false }, createdAt: 0, updatedAt: 0 },
      ],
    }))

    const repo = new AiModelProfileRepository(dir)
    const list = repo.list()
    assert.equal(list.length, 1, 'legacy unsupported profiles should be filtered out')
    assert.equal(list[0].id, 'prof_ok')
    assert.equal(repo.get('prof_anthropic'), null)
    assert.equal(repo.get('prof_google'), null)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Run-mode capability enforcement at the runtime boundary
// ---------------------------------------------------------------------------

test('P1_SUPPORTED_RUN_MODES contains only chat', () => {
  assert.ok(P1_SUPPORTED_RUN_MODES.has('chat'))
  assert.equal(P1_SUPPORTED_RUN_MODES.has('assistant'), false)
  assert.equal(P1_SUPPORTED_RUN_MODES.has('agent'), false)
})

test('runtime.start rejects agent mode with a deferred failed terminal + explicit error', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    const runtime = new AiRuntime({
      providerRegistry: { streamChat: async () => { throw new Error('should not be called') } },
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: sink.emit,
    })
    const { runId } = runtime.start({
      conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'agent', message: 'hi',
    })
    assert.ok(runId, 'start must still return a real runId for an unsupported mode')
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'failed')
    assert.match(terminal.payload.redactedError, /P1 暂不支持该运行模式.*agent/)
    assert.equal(terminal.payload.kind, 'internal')
    assert.equal(terminalTypes(sink.events).length, 1)
    assert.equal(runtime.isActive(runId), false)
    // No provider call was made (the mode check precedes profile/stream setup).
    // No assistant reply persisted.
    const reloaded = conversationRepo.get(conv.id)
    assert.equal(reloaded.messages.filter((m) => m.role === 'assistant').length, 0)
    assert.equal(reloaded.runAuditRefs.length, 1)
    assert.equal(reloaded.runAuditRefs[0].status, 'failed')
  } finally {
    cleanup()
  }
})

test('runtime.start rejects assistant mode with a deferred failed terminal + explicit error', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    const runtime = new AiRuntime({
      providerRegistry: { streamChat: async () => { throw new Error('should not be called') } },
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: sink.emit,
    })
    runtime.start({
      conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'assistant', message: 'hi',
    })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'failed')
    assert.match(terminal.payload.redactedError, /P1 暂不支持该运行模式.*assistant/)
    assert.equal(terminalTypes(sink.events).length, 1)
  } finally {
    cleanup()
  }
})

test('runtime.start accepts chat mode and streams normally', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    const provider = new (await import('../dist-electron/ai-platform/ai-provider-registry.js')).AiProviderRegistry({
      fetch: mockFetch({ deltas: ['ok'] }),
    })
    const runtime = new AiRuntime({
      providerRegistry: provider,
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: sink.emit,
    })
    const { runId } = runtime.start({
      conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'hi',
    })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'completed')
    assert.equal(runtime.isActive(runId), false)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// IPC mode-check logic (mirrors ai:run:start + ai:conversation:create guards)
// ---------------------------------------------------------------------------

test('IPC mode-check logic rejects non-chat modes synchronously (P1_SUPPORTED_RUN_MODES)', () => {
  // The IPC handlers use `P1_SUPPORTED_RUN_MODES.has(mode)` and throw on
  // rejection. This test mirrors that logic to prove the guard rejects
  // agent/assistant without needing the full Electron ipcMain harness.
  const checkMode = (mode) => {
    if (!P1_SUPPORTED_RUN_MODES.has(mode)) {
      throw new Error(`P1 暂不支持该运行模式：${mode}（仅 chat）`)
    }
  }
  assert.doesNotThrow(() => checkMode('chat'))
  assert.throws(() => checkMode('agent'), /agent/)
  assert.throws(() => checkMode('assistant'), /assistant/)
})

// ---------------------------------------------------------------------------
// Actual IPC handler invocation (registerAiIpc + captured ipcMain handlers)
// ---------------------------------------------------------------------------

// Register the electron loader ONCE for the IPC tests below so `electron`
// resolves to the stub (which captures ipcMain.handle registrations).
import { register as registerModule } from 'node:module'
registerModule('./fixtures/electron-loader.mjs', import.meta.url)

const { registerAiIpc } = await import('../dist-electron/ai-platform/ai-ipc.js')
const { createIpcScope } = await import('./fixtures/electron-stub.mjs')

/**
 * Build a registerAiIpc deps fixture with spying on assertTrustedRenderer +
 * conversationRepository.create + runtime.start. Returns the spies so tests
 * can assert ordering and that no side effect ran before the capability check.
 *
 * `options.trustThrows` — when true, assertTrustedRenderer throws a sentinel
 * error. Used by the ordering regression tests to PROVE the trust check runs
 * before the capability guard: if the sentinel wins, trust ran first.
 *
 * Each fixture gets an ISOLATED IPC handler scope (see electron-stub.mjs):
 * node:test runs suites concurrently in one process, and a shared global
 * handler map would race with ai-context-runtime-ipc's registerAiIpc calls.
 * The scope is private to this fixture; invokeHandlerFor routes through it.
 */
function makeIpcFixture(options = {}) {
  const scope = createIpcScope()
  scope.activate()
  const trustCalls = []
  const createCalls = []
  const startCalls = []
  let nextRunId = 'run_mock_1'
  let nextConvId = 'conv_mock_1'
  const TRUST_SENTINEL = new Error('__TRUST_SENTINEL__')
  const deps = {
    mainWindow: () => null,
    assertTrustedRenderer: (event) => {
      trustCalls.push(event)
      if (options.trustThrows) throw TRUST_SENTINEL
    },
    conversationRepository: {
      create: (input) => {
        createCalls.push(input)
        return {
          schemaVersion: 1, id: nextConvId, title: input.title ?? '新会话',
          modelProfileId: input.modelProfileId, mode: input.mode ?? 'chat',
          createdAt: 0, updatedAt: 0, messages: [], runAuditRefs: [],
        }
      },
    },
    profileRepository: { list: () => [], get: () => null, upsert: () => { throw new Error('should not be called') }, delete: () => false },
    credentialVault: { status: () => ({ credentialKey: '', configured: false, encryptionAvailable: true }) },
    runtime: {
      start: (request) => {
        startCalls.push(request)
        return { runId: nextRunId }
      },
      cancel: () => false,
    },
    // P3 stubs: these suites don't exercise P3 channels, but the deps object
    // must satisfy the AiIpcDeps shape so registerAiIpc doesn't break if a
    // future test touches a P3 handler.
    toolRegistry: { list: () => [] },
    approvalManager: { decide: () => { throw new Error('not used') }, listPending: () => [] },
    auditLog: { list: () => [] },
  }
  registerAiIpc(deps)
  return {
    deps, trustCalls, createCalls, startCalls, scope,
    TRUST_SENTINEL,
    bumpRunId: () => { nextRunId = `run_mock_${startCalls.length + 1}` },
  }
}

const TRUSTED_EVENT = { sender: {}, frameId: 0 }

/** Invoke a captured IPC handler in the fixture's scope, always returning a
 *  promise (handlers may throw synchronously; wrap so assert.rejects works). */
function invokeHandlerFor(scope, channel, event, ...args) {
  return Promise.resolve().then(() => scope._invoke(channel, event, ...args))
}

test('ai:conversation:create handler rejects agent mode before create side effect + after trust check', async () => {
  const { trustCalls, createCalls, scope } = makeIpcFixture()
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:conversation:create', TRUSTED_EVENT, {
      modelProfileId: 'prof_a', mode: 'agent',
    }),
    (err) => err instanceof Error && /P1 暂不支持该运行模式.*agent/.test(err.message),
  )
  // assertTrustedRenderer must have been called BEFORE the capability decision.
  assert.equal(trustCalls.length, 1, 'assertTrustedRenderer not called')
  assert.equal(createCalls.length, 0, 'conversationRepository.create ran despite rejected mode')
})

test('ai:conversation:create handler rejects assistant mode before create side effect', async () => {
  const { createCalls, scope } = makeIpcFixture()
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:conversation:create', TRUSTED_EVENT, {
      modelProfileId: 'prof_a', mode: 'assistant',
    }),
    (err) => err instanceof Error && /P1 暂不支持该运行模式.*assistant/.test(err.message),
  )
  assert.equal(createCalls.length, 0)
})

test('ai:conversation:create handler delegates chat mode to conversationRepository.create', async () => {
  const { createCalls, trustCalls, scope } = makeIpcFixture()
  const result = await invokeHandlerFor(scope, 'ai:conversation:create', TRUSTED_EVENT, {
    modelProfileId: 'prof_a', mode: 'chat',
  })
  assert.equal(createCalls.length, 1)
  assert.equal(createCalls[0].mode, 'chat')
  assert.equal(result.mode, 'chat')
  assert.equal(trustCalls.length, 1)
})

test('ai:conversation:create defaults undefined mode to chat and delegates', async () => {
  const { createCalls, scope } = makeIpcFixture()
  const result = await invokeHandlerFor(scope, 'ai:conversation:create', TRUSTED_EVENT, {
    modelProfileId: 'prof_a',
  })
  assert.equal(createCalls.length, 1)
  assert.equal(createCalls[0].mode, 'chat')
  assert.equal(result.mode, 'chat')
})

test('ai:run:start handler rejects agent mode before runtime.start side effect + after trust check', async () => {
  const { trustCalls, startCalls, scope } = makeIpcFixture()
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
      conversationId: 'conv_a', modelProfileId: 'prof_a', mode: 'agent', message: 'hi',
    }),
    (err) => err instanceof Error && /P1 暂不支持该运行模式.*agent/.test(err.message),
  )
  assert.equal(trustCalls.length, 1, 'assertTrustedRenderer not called')
  assert.equal(startCalls.length, 0, 'runtime.start ran despite rejected mode')
})

test('ai:run:start handler rejects assistant mode before runtime.start side effect', async () => {
  const { startCalls, scope } = makeIpcFixture()
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
      conversationId: 'conv_a', modelProfileId: 'prof_a', mode: 'assistant', message: 'hi',
    }),
    (err) => err instanceof Error && /P1 暂不支持该运行模式.*assistant/.test(err.message),
  )
  assert.equal(startCalls.length, 0)
})

test('ai:run:start handler delegates chat mode to runtime.start and returns runId', async () => {
  const { startCalls, trustCalls, scope } = makeIpcFixture()
  const result = await invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
    conversationId: 'conv_a', modelProfileId: 'prof_a', mode: 'chat', message: 'hi',
  })
  assert.equal(startCalls.length, 1)
  assert.equal(startCalls[0].mode, 'chat')
  assert.equal(result.accepted, true)
  assert.ok(result.runId)
  assert.equal(trustCalls.length, 1)
})

// ---------------------------------------------------------------------------
// Ordering regression: assertTrustedRenderer runs BEFORE the capability guard.
// A call-count check cannot prove ordering, so make assertTrustedRenderer
// throw a sentinel; if the sentinel wins (rather than the P1 mode error) and
// no side effect ran, trust ran first.
// ---------------------------------------------------------------------------

test('ORDERING: ai:conversation:create runs assertTrustedRenderer BEFORE the agent-mode guard', async () => {
  const { TRUST_SENTINEL, createCalls, scope } = makeIpcFixture({ trustThrows: true })
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:conversation:create', TRUSTED_EVENT, {
      modelProfileId: 'prof_a', mode: 'agent',
    }),
    (err) => err === TRUST_SENTINEL,
    'the P1 mode error won — assertTrustedRenderer did not run first',
  )
  assert.equal(createCalls.length, 0, 'create ran despite trust throwing')
})

test('ORDERING: ai:conversation:create runs assertTrustedRenderer BEFORE the assistant-mode guard', async () => {
  const { TRUST_SENTINEL, createCalls, scope } = makeIpcFixture({ trustThrows: true })
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:conversation:create', TRUSTED_EVENT, {
      modelProfileId: 'prof_a', mode: 'assistant',
    }),
    (err) => err === TRUST_SENTINEL,
  )
  assert.equal(createCalls.length, 0)
})

test('ORDERING: ai:run:start runs assertTrustedRenderer BEFORE the agent-mode guard', async () => {
  const { TRUST_SENTINEL, startCalls, scope } = makeIpcFixture({ trustThrows: true })
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
      conversationId: 'conv_a', modelProfileId: 'prof_a', mode: 'agent', message: 'hi',
    }),
    (err) => err === TRUST_SENTINEL,
    'the P1 mode error won — assertTrustedRenderer did not run first',
  )
  assert.equal(startCalls.length, 0, 'runtime.start ran despite trust throwing')
})

test('ORDERING: ai:run:start runs assertTrustedRenderer BEFORE the assistant-mode guard', async () => {
  const { TRUST_SENTINEL, startCalls, scope } = makeIpcFixture({ trustThrows: true })
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
      conversationId: 'conv_a', modelProfileId: 'prof_a', mode: 'assistant', message: 'hi',
    }),
    (err) => err === TRUST_SENTINEL,
  )
  assert.equal(startCalls.length, 0)
})

test('ORDERING: assertTrustedRenderer runs before the chat-mode delegation too (ai:conversation:create)', async () => {
  const { TRUST_SENTINEL, createCalls, scope } = makeIpcFixture({ trustThrows: true })
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:conversation:create', TRUSTED_EVENT, {
      modelProfileId: 'prof_a', mode: 'chat',
    }),
    (err) => err === TRUST_SENTINEL,
    'chat delegation proceeded without the trust check running first',
  )
  assert.equal(createCalls.length, 0)
})

test('ORDERING: assertTrustedRenderer runs before the chat-mode delegation too (ai:run:start)', async () => {
  const { TRUST_SENTINEL, startCalls, scope } = makeIpcFixture({ trustThrows: true })
  await assert.rejects(
    () => invokeHandlerFor(scope, 'ai:run:start', TRUSTED_EVENT, {
      conversationId: 'conv_a', modelProfileId: 'prof_a', mode: 'chat', message: 'hi',
    }),
    (err) => err === TRUST_SENTINEL,
  )
  assert.equal(startCalls.length, 0)
})
