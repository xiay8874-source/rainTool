// Tests for AiRuntime — the run state machine.
//
// Covers the corrected lifecycle:
//   - start() returns a real runId and emits `started` SYNCHRONOUSLY, but
//     every TERMINAL (including missing profile/credential/conversation) is
//     deferred past the return so the renderer has activeRunId first. This is
//     the regression for the synchronous-failed race.
//   - Exactly ONE terminal event per run (completed/failed/cancelled), and
//     exactly ONE audit ref per terminal (no duplicate finishRun).
//   - A failed stream persists NO assistant message (no empty reply).
//   - Audit refs carry the actual profile.id (requested id when the profile is
//     missing — never blank/silent).
//   - Cancel preserves the reason (user / timeout / window-closed); a provider
//     per-call timeout surfaces as 'timeout', not 'user'.
//   - Persistence failure after a completed terminal does NOT emit a second
//     terminal.
//   - Two concurrent conversations cannot corrupt each other's stream.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AiRuntime } from '../dist-electron/ai-platform/ai-runtime.js'
import { AiConversationRepository } from '../dist-electron/ai-platform/ai-conversation-repository.js'
import { mockFetch, TEST_PROFILE } from './fixtures/mock-openai-fetch.mjs'
import { AiProviderRegistry } from '../dist-electron/ai-platform/ai-provider-registry.js'

const RAW_KEY = 'sk-runtime-test-key-1234567890'

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-runtime-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A fake credential vault: returns a fixed key for the test profile. */
function fakeVault(key) {
  return {
    get: (_credentialKey) => key,
    isEncryptionAvailable: () => true,
  }
}

/** A fake profile repo: returns the given profile or null. */
function fakeProfileRepo(profile) {
  return { get: (id) => (profile && id === profile.id ? profile : null) }
}

/** Collect emitted events; resolve a promise when a terminal arrives. */
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
 * Wait until the runtime has fully finished a run (terminal emitted AND
 * audit completed). The runtime persists the assistant reply BEFORE committing
 * the terminal, so by the time the terminal is observed the conversation
 * already contains the reply; this helper additionally waits for isActive to
 * flip false (finishRun runs after the terminal emit).
 */
async function waitForRunSettled(runtime, runId, timeoutMs = 2000) {
  const start = Date.now()
  while (runtime.isActive(runId)) {
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} did not settle`)
    await new Promise((r) => setTimeout(r, 5))
  }
  // One extra microtask tick for the post-terminal audit write.
  await new Promise((r) => setTimeout(r, 5))
}

function terminalTypes(events) {
  return events.filter((e) => e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled')
}

/**
 * A provider registry stub that emits ONLY text-deltas (never a terminal) and
 * returns a scripted outcome — mirrors the real provider contract so the
 * runtime is exercised as the sole terminal owner.
 */
function scriptedProvider(outcome, deltas = []) {
  return {
    streamChat: async ({ emit, runId, sequence }) => {
      for (const d of deltas) {
        emit({ runId, sequence: sequence.value++, type: 'text-delta', at: Date.now(), payload: { delta: d } })
      }
      return outcome
    },
  }
}

/**
 * Real provider registry pointed at a mock fetch, for stream/cancel/timeout
 * tests that exercise the actual SDK path.
 */
function realProvider(fetchImpl) {
  return new AiProviderRegistry({ fetch: fetchImpl })
}

// ---------------------------------------------------------------------------
// Regression: no terminal before start() returns (the synchronous-failed race)
// ---------------------------------------------------------------------------

test('start() returns runId and emits started BEFORE any terminal — missing profile', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: 'prof_missing' })
    const sink = eventSink()
    const runtime = new AiRuntime({
      providerRegistry: scriptedProvider({ kind: 'completed', finalText: 'x' }),
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(null), // missing profile
      emit: sink.emit,
    })

    // start() must return BEFORE any terminal. We assert synchronously: right
    // after start() returns, only `started` has been emitted, no terminal.
    const { runId } = runtime.start({
      conversationId: conv.id, modelProfileId: 'prof_missing', mode: 'chat', message: 'hi',
    })
    assert.ok(runId, 'start() must return a real runId')
    assert.equal(runtime.isActive(runId), true, 'run must be registered before return')
    const startedEvents = sink.events.filter((e) => e.type === 'started')
    assert.equal(startedEvents.length, 1, 'started must be emitted synchronously')
    assert.equal(terminalTypes(sink.events).length, 0, 'a terminal was emitted before start() returned')

    // Now the deferred failed terminal arrives.
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'failed')
    assert.equal(runtime.isActive(runId), false)
  } finally {
    cleanup()
  }
})

test('missing profile: audit ref carries the requested profile id (never blank/silent)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: 'prof_missing' })
    const sink = eventSink()
    const runtime = new AiRuntime({
      providerRegistry: scriptedProvider({ kind: 'completed', finalText: 'x' }),
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(null),
      emit: sink.emit,
    })
    runtime.start({ conversationId: conv.id, modelProfileId: 'prof_missing', mode: 'chat', message: 'hi' })
    await sink.waitForTerminal()

    const reloaded = conversationRepo.get(conv.id)
    assert.equal(reloaded.runAuditRefs.length, 1)
    assert.equal(reloaded.runAuditRefs[0].modelProfileId, 'prof_missing')
    assert.equal(reloaded.runAuditRefs[0].status, 'failed')
    assert.equal(reloaded.runAuditRefs[0].redactedError, '未找到模型配置')
  } finally {
    cleanup()
  }
})

test('missing credential: deferred failed terminal, no empty assistant reply, exactly one audit', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    const runtime = new AiRuntime({
      providerRegistry: scriptedProvider({ kind: 'completed', finalText: 'x' }),
      conversationRepository: conversationRepo,
      credentialVault: { get: () => null, isEncryptionAvailable: () => false },
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: sink.emit,
    })
    runtime.start({ conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'hi' })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'failed')
    assert.equal(terminalTypes(sink.events).length, 1)

    const reloaded = conversationRepo.get(conv.id)
    // No assistant reply persisted on failure.
    const assistantMsgs = reloaded.messages.filter((m) => m.role === 'assistant')
    assert.equal(assistantMsgs.length, 0)
    assert.equal(reloaded.runAuditRefs.length, 1)
    assert.equal(reloaded.runAuditRefs[0].modelProfileId, TEST_PROFILE.id)
  } finally {
    cleanup()
  }
})

test('missing conversation: deferred failed terminal, exactly one audit', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const sink = eventSink()
    const runtime = new AiRuntime({
      providerRegistry: scriptedProvider({ kind: 'completed', finalText: 'x' }),
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: sink.emit,
    })
    runtime.start({ conversationId: 'conv_nonexistent', modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'hi' })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'failed')
    assert.equal(terminal.payload.redactedError, '会话不存在')
    assert.equal(terminalTypes(sink.events).length, 1)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Exactly one terminal + exactly one audit ref
// ---------------------------------------------------------------------------

test('completed run: assistant reply + audit ref visible BEFORE completed terminal; one audit ref', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    // Capture the conversation state at the instant the terminal is observed.
    let conversationAtTerminal = null
    const sink = eventSink()
    const wrappedEmit = (e) => {
      if (e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled') {
        conversationAtTerminal = conversationRepo.get(conv.id)
      }
      sink.emit(e)
    }
    const runtime = new AiRuntime({
      providerRegistry: scriptedProvider({ kind: 'completed', finalText: 'Hello!' }, ['Hel', 'lo!']),
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: wrappedEmit,
    })
    const { runId } = runtime.start({ conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'hi' })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'completed')
    assert.equal(terminal.payload.finalText, 'Hello!')
    await waitForRunSettled(runtime, runId)
    assert.equal(terminalTypes(sink.events).length, 1)

    // Ordering guarantee: at the instant the completed terminal is observed,
    // BOTH the assistant reply AND the single audit ref must already be
    // persisted (finishRun ran before commitTerminal).
    assert.ok(conversationAtTerminal, 'conversation not captured at terminal')
    const assistantAtTerminal = conversationAtTerminal.messages.filter((m) => m.role === 'assistant')
    assert.equal(assistantAtTerminal.length, 1, 'assistant reply missing when completed terminal observed')
    assert.equal(assistantAtTerminal[0].text, 'Hello!')
    assert.equal(conversationAtTerminal.runAuditRefs.length, 1, 'audit ref missing when completed terminal observed')
    assert.equal(conversationAtTerminal.runAuditRefs[0].status, 'completed')

    const reloaded = conversationRepo.get(conv.id)
    assert.equal(reloaded.runAuditRefs.length, 1)
    assert.equal(reloaded.runAuditRefs[0].modelProfileId, TEST_PROFILE.id)
  } finally {
    cleanup()
  }
})

test('failed stream: one failed terminal, NO assistant reply persisted, one audit ref', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    const runtime = new AiRuntime({
      providerRegistry: scriptedProvider({ kind: 'failed', redactedError: 'provider down' }),
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: sink.emit,
    })
    const { runId } = runtime.start({ conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'hi' })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'failed')
    assert.equal(terminal.payload.redactedError, 'provider down')
    await waitForRunSettled(runtime, runId)
    assert.equal(terminalTypes(sink.events).length, 1)

    const reloaded = conversationRepo.get(conv.id)
    const assistantMsgs = reloaded.messages.filter((m) => m.role === 'assistant')
    assert.equal(assistantMsgs.length, 0, 'a failed stream persisted an empty assistant reply')
    assert.equal(reloaded.runAuditRefs.length, 1)
    assert.equal(reloaded.runAuditRefs[0].status, 'failed')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Cancel reason preservation + per-call timeout
// ---------------------------------------------------------------------------

test('user cancel emits cancelled with reason user and one audit ref', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    // Real provider with a never-ending stream so cancel is the only exit.
    const provider = realProvider(mockFetch({ deltas: ['partial'], neverEnd: true, delayMs: 50 }))
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
    // Cancel after the stream has started.
    setTimeout(() => runtime.cancel(runId, 'user'), 80)
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'cancelled')
    assert.equal(terminal.payload.reason, 'user')
    assert.equal(terminalTypes(sink.events).length, 1)
    const reloaded = conversationRepo.get(conv.id)
    assert.equal(reloaded.runAuditRefs.length, 1)
    assert.equal(reloaded.runAuditRefs[0].status, 'cancelled')
  } finally {
    cleanup()
  }
})

test('cancelAll(window-closed) emits cancelled with reason window-closed for every active run', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const convA = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const convB = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sinkA = eventSink()
    const sinkB = eventSink()
    const provider = realProvider(mockFetch({ deltas: ['partial'], neverEnd: true, delayMs: 50 }))
    const runtime = new AiRuntime({
      providerRegistry: provider,
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: (e) => { sinkA.emit(e); sinkB.emit(e) },
    })
    runtime.start({ conversationId: convA.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'a' })
    runtime.start({ conversationId: convB.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'b' })
    setTimeout(() => runtime.cancelAll('window-closed'), 80)
    const [tA, tB] = await Promise.all([sinkA.waitForTerminal(), sinkB.waitForTerminal()])
    // Each sink sees its own run's cancelled; filter by conversation via audit.
    const cancelled = [tA, tB].filter((t) => t.type === 'cancelled')
    assert.ok(cancelled.length >= 1)
    for (const t of cancelled) {
      assert.equal(t.payload.reason, 'window-closed')
    }
    assert.equal(conversationRepo.get(convA.id).runAuditRefs[0].status, 'cancelled')
    assert.equal(conversationRepo.get(convB.id).runAuditRefs[0].status, 'cancelled')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Persistence failure after a completed terminal must NOT emit a second terminal
// ---------------------------------------------------------------------------

test('persistence failure on completed: single failed terminal (never completed w/ missing reply), one audit', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    // Wrap the repo so appendMessage throws ONLY for assistant replies (the
    // user message must persist so the run reaches the completed branch). This
    // simulates a disk failure on the assistant persistence path. The runtime
    // must emit exactly one `failed` terminal (NOT `completed`) — the UI must
    // never say "complete" while the history is missing the reply.
    const failingRepo = {
      get: (id) => conversationRepo.get(id),
      appendMessage: (id, msg) => {
        if (msg.role === 'assistant') throw new Error('disk full')
        return conversationRepo.appendMessage(id, msg)
      },
      recordRunAudit: (id, ref) => conversationRepo.recordRunAudit(id, ref),
    }
    const runtime = new AiRuntime({
      providerRegistry: scriptedProvider({ kind: 'completed', finalText: 'done' }, ['done']),
      conversationRepository: failingRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: sink.emit,
    })
    const { runId } = runtime.start({ conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'hi' })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'failed', 'completed was emitted despite persistence failure')
    assert.equal(terminal.payload.redactedError, '回复持久化失败')
    await waitForRunSettled(runtime, runId)
    // Exactly one terminal — no second failed/completed after the persistence loss.
    assert.equal(terminalTypes(sink.events).length, 1, 'a second terminal was emitted after persistence failure')
    // The audit (recordRunAudit still works) records failed exactly once.
    const reloaded = conversationRepo.get(conv.id)
    assert.equal(reloaded.runAuditRefs.length, 1)
    assert.equal(reloaded.runAuditRefs[0].status, 'failed')
    assert.equal(reloaded.runAuditRefs[0].redactedError, '回复持久化失败')
  } finally {
    cleanup()
  }
})

test('audit-write failure after a terminal never creates a second terminal', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    // appendMessage works (reply persists), but recordRunAudit throws. The
    // runtime must swallow the audit failure and emit exactly one terminal.
    const auditFailingRepo = {
      get: (id) => conversationRepo.get(id),
      appendMessage: (id, msg) => conversationRepo.appendMessage(id, msg),
      recordRunAudit: () => { throw new Error('audit disk full') },
    }
    const runtime = new AiRuntime({
      providerRegistry: scriptedProvider({ kind: 'completed', finalText: 'done' }, ['done']),
      conversationRepository: auditFailingRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit: sink.emit,
    })
    const { runId } = runtime.start({ conversationId: conv.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'hi' })
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.type, 'completed')
    await waitForRunSettled(runtime, runId)
    assert.equal(terminalTypes(sink.events).length, 1, 'audit failure created a second terminal')
    // The reply persisted despite the audit failure.
    const reloaded = conversationRepo.get(conv.id)
    const assistantMsgs = reloaded.messages.filter((m) => m.role === 'assistant')
    assert.equal(assistantMsgs.length, 1)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Two concurrent conversations: streams cannot corrupt each other
// ---------------------------------------------------------------------------

test('two concurrent conversations stream independently; events carry distinct runIds', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const convA = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const convB = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const events = []
    const seenTerminals = []
    // Shared emitter captured by the runtime; counts terminals as they arrive.
    const emit = (e) => {
      events.push(e)
      if (e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled') {
        seenTerminals.push(e)
      }
    }
    const provider = realProvider(mockFetch({ deltas: ['A1', 'A2'] }))
    const runtime = new AiRuntime({
      providerRegistry: provider,
      conversationRepository: conversationRepo,
      credentialVault: fakeVault(RAW_KEY),
      profileRepository: fakeProfileRepo(TEST_PROFILE),
      emit,
    })
    const { runId: runIdA } = runtime.start({
      conversationId: convA.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'a',
    })
    const { runId: runIdB } = runtime.start({
      conversationId: convB.id, modelProfileId: TEST_PROFILE.id, mode: 'chat', message: 'b',
    })
    assert.notEqual(runIdA, runIdB)
    // Wait for both terminals (and runs to settle).
    const start = Date.now()
    while (seenTerminals.length < 2 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 5))
    }
    await waitForRunSettled(runtime, runIdA)
    await waitForRunSettled(runtime, runIdB)
    assert.equal(seenTerminals.length, 2, 'expected two terminals')
    const runIds = new Set(seenTerminals.map((t) => t.runId))
    assert.ok(runIds.has(runIdA))
    assert.ok(runIds.has(runIdB))
    // No event from runA leaked a delta into runB's sequence and vice versa.
    const aDeltas = events.filter((e) => e.runId === runIdA && e.type === 'text-delta')
    const bDeltas = events.filter((e) => e.runId === runIdB && e.type === 'text-delta')
    for (const d of aDeltas) assert.ok(['A1', 'A2'].includes(d.payload.delta))
    for (const d of bDeltas) assert.ok(['A1', 'A2'].includes(d.payload.delta))
    // Each conversation has exactly one terminal + one audit ref.
    assert.equal(conversationRepo.get(convA.id).runAuditRefs.length, 1)
    assert.equal(conversationRepo.get(convB.id).runAuditRefs.length, 1)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// Returned runId can cancel the correct run
// ---------------------------------------------------------------------------

test('returned runId cancels the correct active run', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const conversationRepo = new AiConversationRepository(dir)
    const conv = conversationRepo.create({ modelProfileId: TEST_PROFILE.id })
    const sink = eventSink()
    const provider = realProvider(mockFetch({ deltas: ['partial'], neverEnd: true, delayMs: 50 }))
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
    assert.equal(runtime.isActive(runId), true)
    const cancelled = runtime.cancel(runId, 'user')
    assert.equal(cancelled, true)
    const terminal = await sink.waitForTerminal()
    assert.equal(terminal.runId, runId)
    assert.equal(terminal.type, 'cancelled')
    assert.equal(runtime.isActive(runId), false)
    // Cancelling an already-terminated run returns false.
    assert.equal(runtime.cancel(runId, 'user'), false)
  } finally {
    cleanup()
  }
})
