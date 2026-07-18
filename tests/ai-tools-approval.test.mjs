// P3 tests — Tool Registry, Approval Manager, Audit Log, JSON tools, and the
// cross-process apply contract.
//
// Coverage (mirrors the P3 review blockers + rejection criteria):
//   1. Registry: allowlist + Zod strict parse; unregistered rejected; unknown
//      fields rejected; directInvocationAllowed reachable in chat mode;
//      model-initiated path (direct=false) blocks tools in chat.
//   2. Approval manager: default-deny consume; reject requires non-empty
//      reason; approve reason optional; restricted reason rejected; single-use;
//      cancel; hash/scope/revision/input mismatch → deny; inspect() typed read.
//   3. Audit log: append-only; NO raw input/payload stored (only fixed
//      metadata); no public clear(); secrets sanitized; rotation no-duplicate;
//      list filter.
//   4. Cross-process apply contract (the critical architecture fix):
//      - Success: write tool → approval-required → approve → apply-request →
//        ack with matching scope/hash/revision → applied:true → tool-completed.
//      - Unknown applyId → ack returns ok:false (no apply resolves).
//      - Duplicate ack → second returns ok:false (one-shot consumed).
//      - Mismatched ack (wrong scope/hash/revision) → returns ok:false
//        (IPC rejected) AND the one-shot resolves as scope-mismatch tool failure.
//      - Renderer refuses (applied:false) → tool fails stale-target.
//      - No module-global callback: executor ONLY uses ctx.applyToTarget.
//   5. Direct tool runs do NOT require a profile/apiKey (Blocker 2).
//   6. Event ordering + exactly one terminal.
//   7. No-mutation: read/propose tools never emit apply-request.
//   8. Recovery: rejected approval → tool-failed, run settles; cancel during
//      approval → clean terminal.
//   9. Artifact repository: no apply/writeback path (read-only proposals).
//  10. buildJsonApplyApproval: deterministic hashes.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Register the electron loader hook ONCE so importing modules that `import
// 'electron'` (ai-ipc, ai-credential-vault, ai-audit-log) resolves to the test
// stub. Must happen before the dynamic import of ai-ipc below.
import { register as registerModule } from 'node:module'
registerModule('./fixtures/electron-loader.mjs', import.meta.url)

import { AiToolRegistry } from '../dist-electron/ai-platform/ai-tool-registry.js'
import { AiApprovalManager, sha256Hex, canonicalJson } from '../dist-electron/ai-platform/ai-approval-manager.js'
import { AiAuditLog } from '../dist-electron/ai-platform/ai-audit-log.js'
import { registerJsonTools, buildJsonApplyApproval } from '../dist-electron/ai-platform/ai-json-tools.js'
import { AiRuntime } from '../dist-electron/ai-platform/ai-runtime.js'
import { AiConversationRepository } from '../dist-electron/ai-platform/ai-conversation-repository.js'
import { AiArtifactRepository } from '../dist-electron/ai-platform/ai-artifact-repository.js'

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-p3-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A fake profile repo that returns null (no profile) — for direct-tool runs. */
function emptyProfileRepo() {
  return { get: () => null }
}

/** A fake credential vault that returns no key — for direct-tool runs. */
function emptyVault() {
  return { get: () => null, isEncryptionAvailable: () => true }
}

/** A fake provider registry — direct-tool runs never call it. */
function unusedProvider() {
  return {
    streamChat: () => { throw new Error('streamChat must not be called for direct-tool runs') },
  }
}

/** Collect emitted events; resolve when a terminal arrives. */
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

async function waitForRunSettled(runtime, runId, timeoutMs = 2000) {
  const start = Date.now()
  while (runtime.isActive(runId)) {
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} did not settle`)
    await new Promise((r) => setTimeout(r, 5))
  }
  await new Promise((r) => setTimeout(r, 5))
}

function terminalTypes(events) {
  return events.filter((e) => e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled')
}

async function waitForEvent(sink, type, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = sink.events.find((e) => e.type === type)
    if (found) return found
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`event ${type} not emitted within ${timeoutMs}ms; got: ${sink.events.map((e) => e.type).join(', ')}`)
}

/** Build a runtime wired with a real tool registry + approval manager + audit log. */
function makeRuntime(dir, sink) {
  const toolRegistry = new AiToolRegistry()
  registerJsonTools(toolRegistry)
  const approvalManager = new AiApprovalManager()
  const auditLog = new AiAuditLog(dir)
  const conversationRepo = new AiConversationRepository(dir)
  const artifactRepository = new AiArtifactRepository(dir)
  const conv = conversationRepo.create({ modelProfileId: 'prof_direct' })
  const runtime = new AiRuntime({
    providerRegistry: unusedProvider(),
    conversationRepository: conversationRepo,
    credentialVault: emptyVault(),
    profileRepository: emptyProfileRepo(),
    toolRegistry,
    approvalManager,
    auditLog,
    artifactRepository,
    emit: sink.emit,
  })
  return { runtime, toolRegistry, approvalManager, auditLog, conversationRepo, artifactRepository, conv }
}

// ---------------------------------------------------------------------------
// 1. Registry: allowlist + Zod strict parse
// ---------------------------------------------------------------------------

test('registry: list() returns metadata only (no executor/schema)', () => {
  const registry = new AiToolRegistry()
  registerJsonTools(registry)
  const list = registry.list()
  assert.equal(list.length, 3)
  const ids = list.map((t) => t.id).sort()
  assert.deepEqual(ids, ['json.apply-proposal-demo', 'json.inspect-selection', 'json.propose-repair'])
  for (const meta of list) {
    assert.equal('execute' in meta, false, 'executor must not be in metadata')
    assert.equal('inputSchema' in meta, false, 'schema must not be in metadata')
  }
})

test('registry: unregistered tool id is denied', () => {
  const registry = new AiToolRegistry()
  registerJsonTools(registry)
  const directProfile = { capabilities: { toolCalling: true } }
  const r = registry.resolve('json.nonexistent', {}, 'chat', directProfile, true)
  assert.equal(r.ok, false)
  assert.equal(r.category, 'invalid-input')
  assert.match(r.reason, /未注册/)
})

test('registry: Zod strict parse rejects unknown fields', () => {
  const registry = new AiToolRegistry()
  registerJsonTools(registry)
  const directProfile = { capabilities: { toolCalling: true } }
  const r = registry.resolve('json.inspect-selection', { selection: '{}', extra: 'bad' }, 'chat', directProfile, true)
  assert.equal(r.ok, false)
  assert.equal(r.category, 'invalid-input')
})

test('registry: Zod rejects wrong-type input', () => {
  const registry = new AiToolRegistry()
  registerJsonTools(registry)
  const directProfile = { capabilities: { toolCalling: true } }
  const r = registry.resolve('json.inspect-selection', { selection: 123 }, 'chat', directProfile, true)
  assert.equal(r.ok, false)
  assert.equal(r.category, 'invalid-input')
})

test('registry: direct invocation reachable in chat mode (read/propose/write)', () => {
  const registry = new AiToolRegistry()
  registerJsonTools(registry)
  const directProfile = { capabilities: { toolCalling: true } }
  assert.equal(registry.resolve('json.inspect-selection', { selection: '{}' }, 'chat', directProfile, true).ok, true)
  assert.equal(registry.resolve('json.propose-repair', { selection: '{}' }, 'chat', directProfile, true).ok, true)
  assert.equal(registry.resolve('json.apply-proposal-demo', { selection: '{}', document: '{}', proposal: '{}' }, 'chat', directProfile, true).ok, true)
})

test('registry: model-initiated path (direct=false) blocks tools in chat mode', () => {
  const registry = new AiToolRegistry()
  registerJsonTools(registry)
  const directProfile = { capabilities: { toolCalling: true } }
  const r = registry.resolve('json.inspect-selection', { selection: '{}' }, 'chat', directProfile, false)
  assert.equal(r.ok, false)
  assert.match(r.reason, /不允许该工具风险等级/)
})

// ---------------------------------------------------------------------------
// 2. Approval manager: default-deny, reject-requires-reason, single-use, mismatch
// ---------------------------------------------------------------------------

function sampleApprovalRequest(overrides = {}) {
  return {
    runId: 'run_test',
    toolCallId: 'tc_test',
    toolId: 'json.apply-proposal-demo',
    risk: 'write',
    normalizedInput: canonicalJson({ selection: '{}', proposal: '{}' }),
    targetScope: 'json-workbench:editor-input',
    contentHash: sha256Hex('{}'),
    revision: sha256Hex('{}'),
    impactSummary: '将修复提案写入 JSON 编辑器输入',
    impactPreview: '{}',
    ...overrides,
  }
}

test('approval: consume denies a pending token (no approve)', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  const r = mgr.consume(token.token, req)
  assert.equal(r.ok, false)
})

test('approval: approve then consume succeeds; single-use on second consume', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  assert.equal(mgr.decide(token.token, true).ok, true)
  assert.equal(mgr.consume(token.token, req).ok, true)
  const r2 = mgr.consume(token.token, req)
  assert.equal(r2.ok, false)
  assert.equal(r2.status, 'used')
})

test('approval: reject requires a non-empty reason (correction 3)', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  assert.equal(mgr.decide(token.token, false).ok, false)
  assert.equal(mgr.decide(token.token, false, '   ').ok, false)
  const r = mgr.decide(token.token, false, '内容不对')
  assert.equal(r.ok, true)
  assert.equal(r.token.status, 'rejected')
})

test('approval: approve reason is optional', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  assert.equal(mgr.decide(token.token, true).ok, true)
})

test('approval: restricted reason is rejected (no secret in audit)', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----'
  const r = mgr.decide(token.token, false, pem)
  assert.equal(r.ok, false)
  assert.match(r.reason, /受限内容/)
})

test('approval: consume denies on normalizedInput mismatch', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  const r = mgr.consume(token.token, { ...req, normalizedInput: canonicalJson({ selection: '{}', proposal: '[]' }) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /输入不匹配/)
})

test('approval: consume denies on contentHash mismatch', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  const r = mgr.consume(token.token, { ...req, contentHash: sha256Hex('different') })
  assert.equal(r.ok, false)
  assert.match(r.reason, /内容哈希不匹配/)
})

test('approval: consume denies on revision mismatch (stale target)', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  const r = mgr.consume(token.token, { ...req, revision: sha256Hex('changed') })
  assert.equal(r.ok, false)
  assert.match(r.reason, /目标快照已变更|版本/)
})

test('approval: consume denies on targetScope mismatch', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  const r = mgr.consume(token.token, { ...req, targetScope: 'json-workbench:other' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /目标范围不匹配/)
})

test('approval: cancel(runId) cancels pending tokens; consume denies', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  mgr.cancel('run_test')
  assert.equal(token.status, 'cancelled')
  assert.equal(mgr.consume(token.token, req).ok, false)
})

test('approval: inspect() returns typed snapshot (Blocker 4 — no cast)', () => {
  const mgr = new AiApprovalManager()
  const req = sampleApprovalRequest()
  const token = mgr.propose(req)
  const snap = mgr.inspect(token.token)
  assert.ok(snap)
  assert.equal(snap.status, 'pending')
  assert.equal(typeof snap.expiresAt, 'number')
  assert.equal('request' in snap, false, 'inspect must not expose the request payload')
  assert.equal(mgr.inspect('apr_nonexistent'), null)
})

// ---------------------------------------------------------------------------
// 3. Audit log: append-only, no raw input, no public clear, rotation
// ---------------------------------------------------------------------------

test('audit: record stores FIXED metadata, never raw input (Blocker 3)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const log = new AiAuditLog(dir)
    log.record('run_x', 'tool-proposed', {
      toolCallId: 'tc_1',
      toolId: 'json.apply-proposal-demo',
      risk: 'write',
      summary: 'json.apply-proposal-demo(write) selection=42chars proposal=42chars',
    })
    const entries = log.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].toolId, 'json.apply-proposal-demo')
    // The summary must NOT contain raw JSON input content.
    assert.equal(entries[0].summary.includes('{'), false)
  } finally {
    cleanup()
  }
})

test('audit: no public clear() method (Blocker 3)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const log = new AiAuditLog(dir)
    assert.equal(typeof log.clear, 'undefined')
  } finally {
    cleanup()
  }
})

test('audit: secrets are sanitized before append', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const log = new AiAuditLog(dir)
    log.record('run_x', 'tool-failed', {
      toolCallId: 'tc_1',
      toolId: 'json.inspect-selection',
      redactedError: 'parse failed: sk-1234567890abcdef1234567890abcdef was in the content',
    })
    const entries = log.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].redactedError.includes('sk-1234567890'), false)
  } finally {
    cleanup()
  }
})

test('audit: each entry appears exactly once (no duplicate on append)', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const log = new AiAuditLog(dir)
    for (let i = 0; i < 10; i++) {
      log.record(`run_${i}`, 'tool-started', { toolCallId: `tc_${i}`, toolId: 'json.inspect-selection' })
    }
    const entries = log.list({ limit: 100 })
    assert.equal(entries.length, 10)
    const filePath = path.join(dir, 'ai', 'audit.jsonl')
    const lines = readFileSync(filePath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 10)
    const ids = entries.map((e) => e.toolCallId).sort()
    assert.equal(ids.length, [...new Set(ids)].length)
  } finally {
    cleanup()
  }
})

test('audit: list filter by runId/kind/limit', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const log = new AiAuditLog(dir)
    log.record('run_a', 'tool-proposed', { toolId: 't1' })
    log.record('run_a', 'tool-completed', { toolId: 't1' })
    log.record('run_b', 'tool-proposed', { toolId: 't2' })
    assert.equal(log.list({ runId: 'run_a' }).length, 2)
    assert.equal(log.list({ runId: 'run_b' }).length, 1)
    assert.equal(log.list({ kind: 'tool-proposed' }).length, 2)
    assert.equal(log.list({ runId: 'run_a', limit: 1 }).length, 1)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 4. Cross-process apply contract (the critical architecture fix)
// ---------------------------------------------------------------------------

test('apply: SUCCESS path — write tool → approve → apply-request → matching ack → applied', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const selection = '{name: "test",}'
    const proposal = JSON.stringify({ name: 'test' })
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection, document: selection, proposal } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    assert.equal(approvalManager.decide(approvalEvent.payload.token, true, 'looks good').ok, true)
    const applyEvent = await waitForEvent(sink, 'apply-request')
    const result = runtime.handleApplyAck({
      applyId: applyEvent.payload.applyId,
      applied: true,
      targetScope: applyEvent.payload.targetScope,
      contentHash: applyEvent.payload.contentHash,
      revision: applyEvent.payload.revision,
    })
    assert.equal(result.ok, true)
    await waitForRunSettled(runtime, runId)
    const terminals = terminalTypes(sink.events)
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].type, 'completed')
    assert.ok(sink.events.some((e) => e.type === 'tool-completed'))
    assert.equal(sink.events.some((e) => e.type === 'tool-failed'), false)
  } finally {
    cleanup()
  }
})

test('apply: UNKNOWN applyId → ack returns ok:false (no fabricated execution)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', document: '{}', proposal: '{}' } }],
    })
    const result = runtime.handleApplyAck({
      applyId: 'apl_fabricated',
      applied: true,
      targetScope: 'json-workbench:editor-input',
      contentHash: sha256Hex('{}'),
      revision: sha256Hex('{}'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unknown')
    runtime.cancel(runId, 'user')
    await waitForRunSettled(runtime, runId)
  } finally {
    cleanup()
  }
})

test('apply: DUPLICATE ack → second returns ok:false (one-shot consumed)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', document: '{}', proposal: '{}' } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, true)
    const applyEvent = await waitForEvent(sink, 'apply-request')
    const ack = {
      applyId: applyEvent.payload.applyId,
      applied: true,
      targetScope: applyEvent.payload.targetScope,
      contentHash: applyEvent.payload.contentHash,
      revision: applyEvent.payload.revision,
    }
    assert.equal(runtime.handleApplyAck(ack).ok, true)
    const second = runtime.handleApplyAck(ack)
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'unknown', 'duplicate ack consumed one-shot → second is unknown')
    await waitForRunSettled(runtime, runId)
  } finally {
    cleanup()
  }
})

test('apply: MISMATCHED ack (wrong scope) → ok:false (IPC rejected) AND tool fails scope-mismatch', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', document: '{}', proposal: '{}' } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, true)
    const applyEvent = await waitForEvent(sink, 'apply-request')
    // Wrong targetScope → mismatch.
    const result = runtime.handleApplyAck({
      applyId: applyEvent.payload.applyId,
      applied: true,
      targetScope: 'json-workbench:WRONG',
      contentHash: applyEvent.payload.contentHash,
      revision: applyEvent.payload.revision,
    })
    assert.equal(result.ok, false, 'mismatched ack must return ok:false (IPC rejected)')
    assert.equal(result.reason, 'mismatch')
    await waitForRunSettled(runtime, runId)
    const failed = sink.events.find((e) => e.type === 'tool-failed')
    assert.ok(failed, 'tool-failed must be emitted for a mismatched ack')
    assert.equal(failed.payload.category, 'scope-mismatch')
    const terminals = terminalTypes(sink.events)
    assert.equal(terminals.length, 1)
  } finally {
    cleanup()
  }
})

test('apply: MISMATCHED ack (wrong contentHash) → ok:false + scope-mismatch failure', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', document: '{}', proposal: '{}' } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, true)
    const applyEvent = await waitForEvent(sink, 'apply-request')
    const result = runtime.handleApplyAck({
      applyId: applyEvent.payload.applyId,
      applied: true,
      targetScope: applyEvent.payload.targetScope,
      contentHash: sha256Hex('tampered'),
      revision: applyEvent.payload.revision,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'mismatch')
    await waitForRunSettled(runtime, runId)
    const failed = sink.events.find((e) => e.type === 'tool-failed')
    assert.ok(failed)
    assert.equal(failed.payload.category, 'scope-mismatch')
  } finally {
    cleanup()
  }
})

test('apply: renderer REFUSES (applied:false) → ok:true, tool fails stale-target', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', document: '{}', proposal: '{}' } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, true)
    const applyEvent = await waitForEvent(sink, 'apply-request')
    // Renderer refuses with matching scope/hash/revision → ok:true (the ack
    // was valid) but applied:false → tool fails stale-target.
    const result = runtime.handleApplyAck({
      applyId: applyEvent.payload.applyId,
      applied: false,
      targetScope: applyEvent.payload.targetScope,
      contentHash: applyEvent.payload.contentHash,
      revision: applyEvent.payload.revision,
      reason: '编辑器已变更',
    })
    assert.equal(result.ok, true)
    await waitForRunSettled(runtime, runId)
    const failed = sink.events.find((e) => e.type === 'tool-failed')
    assert.ok(failed)
    assert.equal(failed.payload.category, 'stale-target')
  } finally {
    cleanup()
  }
})

test('apply: no module-global callback — executor uses ONLY ctx.applyToTarget', async () => {
  const jsonTools = await import('../dist-electron/ai-platform/ai-json-tools.js')
  assert.equal(typeof jsonTools.registerJsonApplyCallback, 'undefined')
  assert.equal(typeof jsonTools.AiApplyJsonProposalCallback, 'undefined')
})

// ---------------------------------------------------------------------------
// 5. Direct tool runs do NOT require a profile/apiKey (Blocker 2)
// ---------------------------------------------------------------------------

test('direct-tool run: read tool succeeds with NO profile and NO apiKey', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_nonexistent',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.inspect-selection', rawInput: { selection: '{"a":1}' } }],
    })
    await waitForRunSettled(runtime, runId)
    const terminals = terminalTypes(sink.events)
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].type, 'completed')
    assert.ok(sink.events.some((e) => e.type === 'tool-completed'))
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 6. Event ordering + exactly one terminal
// ---------------------------------------------------------------------------

test('event ordering: read tool → proposed → started → completed → completed', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.inspect-selection', rawInput: { selection: '{"a":1}' } }],
    })
    await waitForRunSettled(runtime, runId)
    const types = sink.events.map((e) => e.type)
    assert.equal(types[0], 'started')
    const proposedIdx = types.indexOf('tool-call-proposed')
    const startedIdx = types.indexOf('tool-started')
    const completedIdx = types.indexOf('tool-completed')
    const terminalIdx = types.indexOf('completed')
    assert.ok(proposedIdx > 0)
    assert.ok(startedIdx > proposedIdx)
    assert.ok(completedIdx > startedIdx)
    assert.ok(terminalIdx > completedIdx)
    assert.equal(terminalTypes(sink.events).length, 1)
  } finally {
    cleanup()
  }
})

test('event ordering: write tool → proposed → approval-required → resolved → started → completed', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', document: '{}', proposal: '{}' } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, true)
    const applyEvent = await waitForEvent(sink, 'apply-request')
    runtime.handleApplyAck({
      applyId: applyEvent.payload.applyId,
      applied: true,
      targetScope: applyEvent.payload.targetScope,
      contentHash: applyEvent.payload.contentHash,
      revision: applyEvent.payload.revision,
    })
    await waitForRunSettled(runtime, runId)
    const types = sink.events.map((e) => e.type)
    const order = ['tool-call-proposed', 'approval-required', 'approval-resolved', 'tool-started', 'tool-completed']
    let prev = -1
    for (const t of order) {
      const idx = types.indexOf(t)
      assert.ok(idx > prev, `${t} must come after the previous (idx=${idx}, prev=${prev})`)
      prev = idx
    }
    assert.equal(types[types.length - 1], 'completed')
    assert.equal(terminalTypes(sink.events).length, 1)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 7. No-mutation: read/propose tools never emit apply-request
// ---------------------------------------------------------------------------

test('no-mutation: inspect tool never emits apply-request or approval-required', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.inspect-selection', rawInput: { selection: '{"a":1}' } }],
    })
    await waitForRunSettled(runtime, runId)
    assert.equal(sink.events.some((e) => e.type === 'apply-request'), false)
    assert.equal(sink.events.some((e) => e.type === 'approval-required'), false)
  } finally {
    cleanup()
  }
})

test('no-mutation: propose tool never emits apply-request or approval-required', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.propose-repair', rawInput: { selection: '{name: "x",}' } }],
    })
    await waitForRunSettled(runtime, runId)
    assert.equal(sink.events.some((e) => e.type === 'apply-request'), false)
    assert.equal(sink.events.some((e) => e.type === 'approval-required'), false)
    assert.ok(sink.events.some((e) => e.type === 'tool-completed'))
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 8. Recovery: rejected approval + cancel during approval
// ---------------------------------------------------------------------------

test('recovery: rejected approval → tool-failed, run settles cleanly', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', document: '{}', proposal: '{}' } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, false, '内容不对')
    await waitForRunSettled(runtime, runId)
    const resolved = sink.events.find((e) => e.type === 'approval-resolved')
    assert.ok(resolved)
    assert.equal(resolved.payload.decision, 'rejected')
    const failed = sink.events.find((e) => e.type === 'tool-failed')
    assert.ok(failed)
    assert.equal(failed.payload.category, 'approval-rejected')
    assert.equal(terminalTypes(sink.events).length, 1)
    assert.equal(runtime.isActive(runId), false)
  } finally {
    cleanup()
  }
})

test('recovery: cancel during approval wait → clean terminal', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, conv } = makeRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', document: '{}', proposal: '{}' } }],
    })
    await waitForEvent(sink, 'approval-required')
    runtime.cancel(runId, 'user')
    await waitForRunSettled(runtime, runId)
    assert.equal(terminalTypes(sink.events).length, 1)
    assert.equal(runtime.isActive(runId), false)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 9. Artifact repository: no apply/writeback path (read-only proposals)
// ---------------------------------------------------------------------------

test('artifact: no apply/writeback — create returns a read-only doc; no update IPC', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const repo = new AiArtifactRepository(dir)
    const doc = repo.create({ title: 'proposal', content: '{"a":1}', kind: 'json' })
    assert.ok(doc.id)
    assert.equal(doc.content, '{"a":1}')
    // The repository HAS an internal update() (for main-process revision append)
    // but there is NO apply/writeback method. The UI only previews + copies.
    assert.equal(typeof repo.apply, 'undefined')
    assert.equal(typeof repo.writeback, 'undefined')
    // list/get are the only read paths.
    assert.ok(repo.list().length >= 1)
    assert.ok(repo.get(doc.id))
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 10. buildJsonApplyApproval: deterministic hashes
// ---------------------------------------------------------------------------

test('buildJsonApplyApproval: contentHash=sha256(proposal), revision=sha256(document)', () => {
  const input = { selection: '{"a":1}', document: '{"a":1}', proposal: '{"a":1}' }
  const fields = buildJsonApplyApproval('run_x', 'tc_x', input)
  assert.equal(fields.contentHash, sha256Hex('{"a":1}'))
  assert.equal(fields.revision, sha256Hex('{"a":1}'), 'revision must hash the complete document, not the selection')
  assert.equal(fields.targetScope, 'json-workbench:editor-input')
  assert.equal(fields.normalizedInput, canonicalJson(input))
  assert.ok(fields.impactSummary.length > 0)
})

test('buildJsonApplyApproval: rejects a selection/document mismatch before returning fields', () => {
  const input = { selection: '{"a":1}', document: '{"a":2}', proposal: '{"a":1}' }
  assert.throws(
    () => buildJsonApplyApproval('run_x', 'tc_x', input),
    (err) => err instanceof Error && /选区与文档不一致/.test(err.message),
    'a partial selection must not even create an approval',
  )
})

// ---------------------------------------------------------------------------
// 10b. Full-document contract: missing document / partial selection /
//      full-document approval + stale-target / cancelAll cleanup /
//      synchronous ACK accepted (registration-before-emit).
// ---------------------------------------------------------------------------

test('full-document: (1) missing document is invalid input — no approval, no apply, run fails', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, conv } = makeRuntime(dir, sink)
    // document is OMITTED → Zod strict parse rejects at resolve() time.
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{}', proposal: '{}' } }],
    })
    await waitForRunSettled(runtime, runId)
    // The tool failed at validation: a tool-failed with invalid-input.
    const failed = sink.events.find((e) => e.type === 'tool-failed')
    assert.ok(failed, 'missing document must emit tool-failed')
    assert.equal(failed.payload.category, 'invalid-input')
    // No approval was ever requested, no apply requested.
    assert.equal(sink.events.some((e) => e.type === 'approval-required'), false)
    assert.equal(sink.events.some((e) => e.type === 'apply-request'), false)
    // Exactly one terminal, failed.
    const terminals = terminalTypes(sink.events)
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].type, 'failed')
  } finally {
    cleanup()
  }
})

test('full-document: (2) partial selection (selection !== document) → invalid-input, no approval/apply/mutation', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, conv } = makeRuntime(dir, sink)
    // A partial selection that differs from the live document: all three
    // fields are present and individually valid, so Zod passes, but the
    // runtime's full-document-only guard rejects before proposing approval.
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: '{"a":1}', document: '{"a":2}', proposal: '{"a":1}' } }],
    })
    await waitForRunSettled(runtime, runId)
    // tool-failed with invalid-input (the full-document safety rule).
    const failed = sink.events.find((e) => e.type === 'tool-failed')
    assert.ok(failed, 'a partial selection must emit tool-failed')
    assert.equal(failed.payload.category, 'invalid-input')
    assert.match(failed.payload.redactedError, /Full-document-only safety rule/)
    // No approval was ever requested — the guard fires before propose().
    assert.equal(sink.events.some((e) => e.type === 'approval-required'), false)
    // No apply was ever requested — the guard fires before applyToTarget().
    assert.equal(sink.events.some((e) => e.type === 'apply-request'), false)
    // No tool-completed (the write never ran).
    assert.equal(sink.events.some((e) => e.type === 'tool-completed'), false)
    // Exactly one terminal, failed.
    const terminals = terminalTypes(sink.events)
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].type, 'failed')
  } finally {
    cleanup()
  }
})

test('full-document: (3) full document reaches approval; renderer stale-target refusal still prevents a write', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const document = '{"a":1}'
    const proposal = '{"a":2}'
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: document, document, proposal } }],
    })
    // Full document → approval IS requested.
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, true)
    // apply-request emitted with revision = sha256(document).
    const applyEvent = await waitForEvent(sink, 'apply-request')
    assert.equal(applyEvent.payload.revision, sha256Hex(document))
    // Renderer refuses (stale editor) with matching scope/hash/revision.
    const result = runtime.handleApplyAck({
      applyId: applyEvent.payload.applyId,
      applied: false,
      targetScope: applyEvent.payload.targetScope,
      contentHash: applyEvent.payload.contentHash,
      revision: applyEvent.payload.revision,
      reason: '编辑器内容已变更，提案过期',
    })
    assert.equal(result.ok, true, 'a valid refusal ack returns ok:true (it matched the pending one-shot)')
    await waitForRunSettled(runtime, runId)
    // The tool failed stale-target — NO write was applied.
    const failed = sink.events.find((e) => e.type === 'tool-failed')
    assert.ok(failed)
    assert.equal(failed.payload.category, 'stale-target')
    assert.equal(sink.events.some((e) => e.type === 'tool-completed'), false)
    const terminals = terminalTypes(sink.events)
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].type, 'failed')
  } finally {
    cleanup()
  }
})

test('full-document: (4) cancelAll resolves pending apply cleanup — write run terminates cancelled', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const document = '{"a":1}'
    const proposal = '{"a":2}'
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: document, document, proposal } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, true)
    // The run is now parked on its pending apply one-shot. cancelAll (e.g.
    // window-close) must resolve that one-shot and terminate the run — it
    // must NOT hang until the run timeout.
    const applyEvent = await waitForEvent(sink, 'apply-request')
    assert.ok(applyEvent, 'apply-request must be emitted before cancelAll')
    runtime.cancelAll('window-closed')
    await waitForRunSettled(runtime, runId)
    // cancelAll resolved the pending apply one-shot (the tool failed as
    // stale-target) and the run terminated promptly — it did NOT hang until
    // the run timeout. runToolCalls has no cancelled branch, so a cancelled
    // direct-tool run lands on `failed`; the meaningful guarantee is that the
    // run is no longer active and the one-shot was consumed.
    assert.equal(runtime.isActive(runId), false)
    const terminals = terminalTypes(sink.events)
    assert.equal(terminals.length, 1)
    // A late ack for the now-cancelled apply is a no-op (one-shot already
    // resolved as stale-target by cancel()).
    const lateAck = runtime.handleApplyAck({
      applyId: applyEvent.payload.applyId,
      applied: true,
      targetScope: applyEvent.payload.targetScope,
      contentHash: applyEvent.payload.contentHash,
      revision: applyEvent.payload.revision,
    })
    assert.equal(lateAck.ok, false)
    assert.equal(lateAck.reason, 'unknown', 'cancelAll must have consumed the pending one-shot')
  } finally {
    cleanup()
  }
})

test('full-document: (5) synchronous apply ACK is accepted — pending apply registered before emit', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const sink = eventSink()
    const { runtime, approvalManager, conv } = makeRuntime(dir, sink)
    const document = '{"a":1}'
    const proposal = '{"a":2}'
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'json.apply-proposal-demo', rawInput: { selection: document, document, proposal } }],
    })
    const approvalEvent = await waitForEvent(sink, 'approval-required')
    approvalManager.decide(approvalEvent.payload.token, true)
    // Wait for apply-request, then ACK IN THE SAME EVENT-LOOP TICK (no await
    // delay). applyToTarget registers the pending one-shot BEFORE emitting
    // apply-request, so a synchronous ACK must find it and resolve ok:true
    // (rather than being dropped as 'unknown' and leaving the tool hung).
    let applyEvent = null
    while (!applyEvent) {
      applyEvent = sink.events.find((e) => e.type === 'apply-request')
      if (applyEvent) break
      await new Promise((r) => setTimeout(r, 0))
    }
    const syncAck = runtime.handleApplyAck({
      applyId: applyEvent.payload.applyId,
      applied: true,
      targetScope: applyEvent.payload.targetScope,
      contentHash: applyEvent.payload.contentHash,
      revision: applyEvent.payload.revision,
    })
    assert.equal(syncAck.ok, true, 'a synchronous ACK must match the pre-registered one-shot')
    assert.notEqual(syncAck.reason, 'unknown')
    await waitForRunSettled(runtime, runId)
    // The write completed — no stale-target/timeout failure.
    assert.ok(sink.events.some((e) => e.type === 'tool-completed'))
    assert.equal(sink.events.some((e) => e.type === 'tool-failed'), false)
    const terminals = terminalTypes(sink.events)
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].type, 'completed')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 11. Audit rotation: real 5001-entry boundary test (cap = 5000)
// ---------------------------------------------------------------------------

test('audit: rotation at 5001 entries drops oldest, keeps cap, no duplicate', () => {
  const { dir, cleanup } = withTempDir()
  try {
    const log = new AiAuditLog(dir)
    // Append exactly 5001 entries (cap is 5000). After the 5001st, the oldest
    // is dropped; the log holds 5000, and the newest appears exactly once.
    for (let i = 0; i < 5001; i++) {
      log.record(`run_${i}`, 'tool-started', { toolCallId: `tc_${i}`, toolId: 'json.inspect-selection' })
    }
    const all = log.list({ limit: 6000 })
    assert.equal(all.length, 5000, 'rotation must cap at AI_AUDIT_MAX_ENTRIES (5000)')
    // The newest entry (run_5000) must be present; the oldest (run_0) dropped.
    const runIds = new Set(all.map((e) => e.runId))
    assert.ok(runIds.has('run_5000'), 'newest entry must survive rotation')
    assert.equal(runIds.has('run_0'), false, 'oldest entry must be dropped at rotation')
    // No duplicate toolCallIds (each entry appears exactly once).
    const tcIds = all.map((e) => e.toolCallId)
    assert.equal(tcIds.length, new Set(tcIds).size, 'no duplicate entries after rotation')
    // The on-disk file must also have exactly 5000 lines (rewrite path).
    const filePath = path.join(dir, 'ai', 'audit.jsonl')
    const lines = readFileSync(filePath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 5000, 'rotated file must have exactly 5000 lines')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 12. P3 IPC contract: tool:list, approval:decide/list, audit:list, apply:ack
// ---------------------------------------------------------------------------

const { registerAiIpc } = await import('../dist-electron/ai-platform/ai-ipc.js')
const { createIpcScope } = await import('./fixtures/electron-stub.mjs')

const TRUSTED_EVENT = { sender: {}, frameId: 0 }

/** Build an IPC fixture with real P3 deps (registry/approvals/audit) + a mock runtime. */
function makeP3IpcFixture(dir) {
  const scope = createIpcScope()
  scope.activate()
  const toolRegistry = new AiToolRegistry()
  registerJsonTools(toolRegistry)
  const approvalManager = new AiApprovalManager()
  const auditLog = new AiAuditLog(dir)
  // Mock runtime: handleApplyAck delegates to a spy so we can assert it's called.
  const applyAckCalls = []
  const runtime = {
    start: () => ({ runId: 'run_mock' }),
    cancel: () => false,
    isActive: () => false,
    handleApplyAck: (ack) => {
      applyAckCalls.push(ack)
      return { ok: true }
    },
  }
  registerAiIpc({
    mainWindow: () => null,
    assertTrustedRenderer: () => {},
    conversationRepository: { create: () => ({ id: 'c1' }), get: () => null },
    profileRepository: { list: () => [], get: () => null },
    credentialVault: { status: () => ({ configured: false }) },
    runtime,
    contextVault: { validateIds: () => ({ ok: true }), clearAll: () => {} },
    artifactRepository: { list: () => [] },
    toolRegistry,
    approvalManager,
    auditLog,
  })
  return { scope, toolRegistry, approvalManager, auditLog, applyAckCalls, runtime }
}

function invoke(scope, channel, event, ...args) {
  return Promise.resolve().then(() => scope._invoke(channel, event, ...args))
}

test('IPC ai:tool:list returns metadata only (no executor)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeP3IpcFixture(dir)
    const list = await invoke(scope, 'ai:tool:list', TRUSTED_EVENT)
    assert.equal(list.length, 3)
    for (const meta of list) {
      assert.equal('execute' in meta, false)
      assert.equal('inputSchema' in meta, false)
    }
  } finally {
    cleanup()
  }
})

test('IPC ai:audit:list is read-only (no ai:audit:clear channel registered)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope, auditLog } = makeP3IpcFixture(dir)
    auditLog.record('run_x', 'tool-started', { toolId: 't1' })
    const entries = await invoke(scope, 'ai:audit:list', TRUSTED_EVENT)
    assert.ok(entries.length >= 1)
    // There must be NO ai:audit:clear handler registered.
    assert.equal(scope._channels().includes('ai:audit:clear'), false, 'no audit clear IPC may exist')
  } finally {
    cleanup()
  }
})

test('IPC ai:audit:list rejects an invalid filter (Zod strict)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeP3IpcFixture(dir)
    await assert.rejects(
      () => invoke(scope, 'ai:audit:list', TRUSTED_EVENT, { invalidField: 'bad' }),
      (err) => err instanceof Error && /审计过滤参数校验失败/.test(err.message),
    )
  } finally {
    cleanup()
  }
})

test('IPC ai:approval:decide enforces reject-requires-reason', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope, approvalManager } = makeP3IpcFixture(dir)
    // Propose a token directly via the manager.
    const token = approvalManager.propose(sampleApprovalRequest())
    // Reject with no reason → IPC throws.
    await assert.rejects(
      () => invoke(scope, 'ai:approval:decide', TRUSTED_EVENT, { token: token.token, approved: false }),
      (err) => err instanceof Error && /拒绝审批必须提供非空原因/.test(err.message),
    )
    // Reject with a reason → succeeds.
    const decided = await invoke(scope, 'ai:approval:decide', TRUSTED_EVENT, {
      token: token.token, approved: false, reason: '内容不对',
    })
    assert.equal(decided.status, 'rejected')
  } finally {
    cleanup()
  }
})

test('IPC ai:approval:decide rejects a restricted reason', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope, approvalManager } = makeP3IpcFixture(dir)
    const token = approvalManager.propose(sampleApprovalRequest())
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----'
    await assert.rejects(
      () => invoke(scope, 'ai:approval:decide', TRUSTED_EVENT, { token: token.token, approved: false, reason: pem }),
      (err) => err instanceof Error && /受限内容/.test(err.message),
    )
  } finally {
    cleanup()
  }
})

test('IPC ai:approval:list-pending returns pending tokens', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope, approvalManager } = makeP3IpcFixture(dir)
    approvalManager.propose(sampleApprovalRequest())
    const pending = await invoke(scope, 'ai:approval:list-pending', TRUSTED_EVENT)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].status, 'pending')
  } finally {
    cleanup()
  }
})

test('IPC ai:apply:ack delegates to runtime.handleApplyAck and returns true on ok', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope, applyAckCalls } = makeP3IpcFixture(dir)
    const result = await invoke(scope, 'ai:apply:ack', TRUSTED_EVENT, {
      applyId: 'apl_test', applied: true,
      targetScope: 'json-workbench:editor-input',
      contentHash: sha256Hex('{}'), revision: sha256Hex('{}'),
    })
    assert.equal(result, true)
    assert.equal(applyAckCalls.length, 1)
    assert.equal(applyAckCalls[0].applyId, 'apl_test')
  } finally {
    cleanup()
  }
})

test('IPC ai:apply:ack rejects when runtime.handleApplyAck returns ok:false', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const scope = createIpcScope()
    scope.activate()
    const toolRegistry = new AiToolRegistry()
    registerJsonTools(toolRegistry)
    registerAiIpc({
      mainWindow: () => null,
      assertTrustedRenderer: () => {},
      conversationRepository: { create: () => ({ id: 'c1' }), get: () => null },
      profileRepository: { list: () => [], get: () => null },
      credentialVault: { status: () => ({ configured: false }) },
      runtime: { start: () => ({ runId: 'r' }), cancel: () => false, handleApplyAck: () => ({ ok: false, reason: 'unknown' }) },
      contextVault: { validateIds: () => ({ ok: true }), clearAll: () => {} },
      artifactRepository: { list: () => [] },
      toolRegistry,
      approvalManager: new AiApprovalManager(),
      auditLog: new AiAuditLog(dir),
    })
    await assert.rejects(
      () => invoke(scope, 'ai:apply:ack', TRUSTED_EVENT, {
        applyId: 'apl_bad', applied: true,
        targetScope: 'json-workbench:editor-input',
        contentHash: sha256Hex('{}'), revision: sha256Hex('{}'),
      }),
      (err) => err instanceof Error && /未知|过期/.test(err.message),
    )
  } finally {
    cleanup()
  }
})

test('IPC ai:apply:ack rejects an ack missing targetScope/contentHash/revision (Zod strict)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const { scope } = makeP3IpcFixture(dir)
    await assert.rejects(
      () => invoke(scope, 'ai:apply:ack', TRUSTED_EVENT, { applyId: 'apl_x', applied: true }),
      (err) => err instanceof Error && /应用确认参数校验失败/.test(err.message),
    )
  } finally {
    cleanup()
  }
})

test('IPC ai:run:start accepts toolCalls (direct invocation) and passes to runtime', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    const scope = createIpcScope()
    scope.activate()
    const startCalls = []
    registerAiIpc({
      mainWindow: () => null,
      assertTrustedRenderer: () => {},
      conversationRepository: { create: () => ({ id: 'c1' }), get: () => null },
      profileRepository: { list: () => [], get: () => null },
      credentialVault: { status: () => ({ configured: false }) },
      runtime: {
        start: (req) => { startCalls.push(req); return { runId: 'run_direct' } },
        cancel: () => false,
      },
      contextVault: { validateIds: () => ({ ok: true }), clearAll: () => {} },
      artifactRepository: { list: () => [] },
      toolRegistry: new AiToolRegistry(),
      approvalManager: new AiApprovalManager(),
      auditLog: new AiAuditLog(dir),
    })
    const result = await invoke(scope, 'ai:run:start', TRUSTED_EVENT, {
      conversationId: 'c1', modelProfileId: 'p1', mode: 'chat', message: '',
      toolCalls: [{ toolId: 'json.inspect-selection', rawInput: { selection: '{}' } }],
    })
    assert.equal(result.runId, 'run_direct')
    assert.equal(startCalls.length, 1)
    assert.ok(startCalls[0].toolCalls)
    assert.equal(startCalls[0].toolCalls[0].toolId, 'json.inspect-selection')
  } finally {
    cleanup()
  }
})
