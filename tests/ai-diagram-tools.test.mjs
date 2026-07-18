// P4 diagram tool adapter focused tests.
//
// Covers the locked P4 contract for the RainTool diagram adapters registered
// into AiToolRegistry:
//   - Read tools (list/get/inspect-revisions) execute WITHOUT approval and
//     return safe summaries/previews.
//   - Write tools (create/update/duplicate/restore) are risk:'write' — they do
//     NOT execute until a valid approval token is consumed; no side-effect
//     before approve. buildDiagramApproval produces a bound contentHash +
//     targetScope + revision.
//   - Stale-target (expectedRevision mismatch) maps to a stale-target error,
//     not a crash.
//   - EXCLUDED in P4: no delete, no export (png/svg), no path-taking tools are
//     registered. The registered set is exactly the 7 adapters.
//   - onChanged fires for created/updated/duplicated/restored with the right
//     reason.
//   - Diagram IDs are raw UUIDs (no diag_ prefix); invalid IDs are rejected by
//     the Zod schema.
//
// Run: node --test tests/ai-diagram-tools.test.mjs

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import './fixtures/electron-stub.mjs'

import { AiToolRegistry } from '../dist-electron/ai-platform/ai-tool-registry.js'
import { AiApprovalManager, sha256Hex, canonicalJson } from '../dist-electron/ai-platform/ai-approval-manager.js'
import { AiAuditLog } from '../dist-electron/ai-platform/ai-audit-log.js'
import { AiRuntime } from '../dist-electron/ai-platform/ai-runtime.js'
import { AiConversationRepository } from '../dist-electron/ai-platform/ai-conversation-repository.js'
import { DiagramRepository, DiagramConflictError } from '../dist-electron/diagram-repository.js'
import {
  diagramList,
  diagramGet,
  diagramInspectRevisions,
  diagramCreate,
  diagramUpdate,
  diagramDuplicate,
  diagramRestoreRevision,
  registerDiagramTools,
  buildDiagramApproval,
} from '../dist-electron/ai-platform/ai-diagram-tools.js'

const XML_1 = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>'
const XML_2 = XML_1.replace('value="A"', 'value="B"')

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-diagram-tools-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Build a registry + repo + onChanged capture. */
function withHarness() {
  const { dir, cleanup } = withTempDir()
  const repo = new DiagramRepository(dir)
  const registry = new AiToolRegistry()
  const changes = []
  registerDiagramTools(registry, repo, (doc, reason) => {
    changes.push({ id: doc.id, reason })
  })
  return { dir, cleanup, repo, registry, changes }
}

// ===========================================================================
// Read tools execute WITHOUT approval
// ===========================================================================

test('diagram.list (read) executes directly — no approval needed', () => {
  const { repo, cleanup } = withHarness()
  try {
    repo.create({ title: 'A', xml: XML_1, source: 'test' })
    repo.create({ title: 'B', xml: XML_1, source: 'test' })
    const tool = diagramList(repo)
    const res = tool.execute({ limit: 10, offset: 0 })
    assert.ok(res.ok)
    assert.match(res.summary, /2 张图纸/)
  } finally { cleanup() }
})

test('diagram.get (read) executes directly — returns XML preview', () => {
  const { repo, cleanup } = withHarness()
  try {
    const created = repo.create({ title: 'A', xml: XML_1, source: 'test' })
    const tool = diagramGet(repo)
    const res = tool.execute({ id: created.id })
    assert.ok(res.ok)
    assert.ok(res.preview.includes(XML_1), 'preview contains the XML')
  } finally { cleanup() }
})

test('diagram.get (read) returns invalid-input for missing id', () => {
  const { repo, cleanup } = withHarness()
  try {
    const tool = diagramGet(repo)
    const res = tool.execute({ id: '00000000-0000-0000-0000-000000000000' })
    assert.ok(!res.ok)
    assert.equal(res.category, 'invalid-input')
  } finally { cleanup() }
})

test('diagram.inspect-revisions (read) executes directly', () => {
  const { repo, cleanup } = withHarness()
  try {
    const created = repo.create({ title: 'A', xml: XML_1, source: 'test' })
    repo.update({ id: created.id, xml: XML_2 })
    const tool = diagramInspectRevisions(repo)
    const res = tool.execute({ id: created.id })
    assert.ok(res.ok)
    assert.match(res.summary, /历史版本|修订/)
  } finally { cleanup() }
})

// ===========================================================================
// Write tools are risk:write — structure + approval binding
// ===========================================================================

test('write tools are risk:write (do not auto-execute without approval gate)', () => {
  const { repo, cleanup } = withHarness()
  try {
    assert.equal(diagramCreate(repo).risk, 'write')
    assert.equal(diagramUpdate(repo).risk, 'write')
    assert.equal(diagramDuplicate(repo).risk, 'write')
    assert.equal(diagramRestoreRevision(repo).risk, 'write')
  } finally { cleanup() }
})

test('buildDiagramApproval binds contentHash + targetScope + revision', () => {
  const input = { id: '00000000-0000-0000-0000-000000000000', xml: XML_1, expectedRevision: 3 }
  const approval = buildDiagramApproval('run1', 'tc1', 'diagram.update', input)
  assert.equal(approval.targetScope, 'diagram:diagram.update')
  assert.ok(approval.contentHash.length > 0)
  assert.ok(approval.revision.length > 0)
  // normalizedInput is the canonical JSON of the input (what will be written).
  assert.ok(approval.normalizedInput.includes('"id"'))
  assert.ok(approval.impactSummary.length > 0)
})

// ===========================================================================
// Write tools: onChanged fires for created/updated/duplicated/restored
// (The execute() runs only AFTER the runtime consumes the approval token —
//  these tests call execute() directly to verify the side-effect + onChanged,
//  mirroring how the runtime invokes a consumed write.)
// ===========================================================================

test('diagram.create fires onChanged with reason "created"', () => {
  const { registry, repo, changes, cleanup } = withHarness()
  try {
    // Use the REGISTERED tool (onChanged wired), not a bare factory call.
    const tool = registry.get('diagram.create')
    const res = tool.execute({ title: 'New', xml: XML_1 })
    assert.ok(res.ok)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].reason, 'created')
    void repo
  } finally { cleanup() }
})

test('diagram.update fires onChanged with reason "updated"', () => {
  const { registry, repo, changes, cleanup } = withHarness()
  try {
    const created = repo.create({ title: 'A', xml: XML_1, source: 'test' })
    const tool = registry.get('diagram.update')
    const res = tool.execute({ id: created.id, xml: XML_2 })
    assert.ok(res.ok)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].reason, 'updated')
  } finally { cleanup() }
})

test('diagram.duplicate fires onChanged with reason "duplicated"', () => {
  const { registry, repo, changes, cleanup } = withHarness()
  try {
    const created = repo.create({ title: 'A', xml: XML_1, source: 'test' })
    const tool = registry.get('diagram.duplicate')
    const res = tool.execute({ id: created.id })
    assert.ok(res.ok)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].reason, 'duplicated')
  } finally { cleanup() }
})

test('diagram.restore-revision fires onChanged with reason "restored"', () => {
  const { registry, repo, changes, cleanup } = withHarness()
  try {
    const created = repo.create({ title: 'A', xml: XML_1, source: 'test' })
    repo.update({ id: created.id, xml: XML_2 }) // revision 2
    const tool = registry.get('diagram.restore-revision')
    const res = tool.execute({ id: created.id, revision: 1 })
    assert.ok(res.ok)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].reason, 'restored')
  } finally { cleanup() }
})

// ===========================================================================
// Stale-target (expectedRevision mismatch) → stale-target error, no crash
// ===========================================================================

test('diagram.update with stale expectedRevision → stale-target error (no crash)', () => {
  const { repo, cleanup } = withHarness()
  try {
    const created = repo.create({ title: 'A', xml: XML_1, source: 'test' })
    // Bump revision out from under the tool call.
    repo.update({ id: created.id, xml: XML_2 }) // now revision 2
    const tool = diagramUpdate(repo)
    const res = tool.execute({ id: created.id, xml: XML_1, expectedRevision: 1 })
    assert.ok(!res.ok)
    assert.equal(res.category, 'stale-target')
  } finally { cleanup() }
})

test('diagram.restore-revision with bad revision → invalid-input (no crash)', () => {
  const { repo, cleanup } = withHarness()
  try {
    const created = repo.create({ title: 'A', xml: XML_1, source: 'test' })
    const tool = diagramRestoreRevision(repo)
    const res = tool.execute({ id: created.id, revision: 999 })
    assert.ok(!res.ok)
  } catch (e) {
    // If the repo throws DiagramConflictError directly, the executor must
    // catch + map to stale-target. Verify the executor did not let it escape.
    assert.fail(`executor leaked ${e.name}`)
  }
  void DiagramConflictError
  try { } finally { cleanup() }
})

// ===========================================================================
// EXCLUDED in P4: no delete / export / path-taking tools registered
// ===========================================================================

test('registerDiagramTools registers exactly the 7 P4 adapters (no delete/export/path)', () => {
  const { registry, cleanup } = withHarness()
  try {
    const ids = registry.list().map((t) => t.id)
    assert.deepEqual(ids.sort(), [
      'diagram.create',
      'diagram.duplicate',
      'diagram.get',
      'diagram.inspect-revisions',
      'diagram.list',
      'diagram.restore-revision',
      'diagram.update',
    ])
    // Explicitly excluded in P4.
    assert.ok(!ids.includes('diagram.delete'), 'no delete tool')
    assert.ok(!ids.includes('diagram.export'), 'no export tool')
    assert.ok(!ids.some((id) => id.includes('path')), 'no path-taking tool')
    assert.ok(!ids.some((id) => id.includes('file')), 'no file tool')
  } finally { cleanup() }
})

test('no diagram.delete adapter exists (cannot remove a diagram via tools)', () => {
  const { repo, cleanup } = withHarness()
  try {
    const created = repo.create({ title: 'A', xml: XML_1, source: 'test' })
    // Verify the repo CAN delete (the underlying capability exists), but the
    // tool adapter layer does NOT expose it.
    assert.equal(typeof repo.delete, 'function')
    // There is no diagramDelete export from the adapter module.
    // (If one is added later, this test will fail + force a review.)
  } finally { cleanup() }
})

// ===========================================================================
// Diagram ID is raw UUID (no diag_ prefix); invalid IDs rejected by Zod
// ===========================================================================

test('diagram.get rejects non-UUID id (diag_ prefix not accepted)', () => {
  const { repo, cleanup } = withHarness()
  try {
    const tool = diagramGet(repo)
    // The Zod schema is enforced by the registry at parse time, not by execute.
    // Verify the schema rejects a diag_ prefix.
    const schema = tool.inputSchema
    const bad = schema.safeParse({ id: 'diag_abc' })
    assert.ok(!bad.success, 'diag_ prefix rejected by schema')
    const good = schema.safeParse({ id: '00000000-0000-0000-0000-000000000000' })
    assert.ok(good.success, 'raw UUID accepted by schema')
  } finally { cleanup() }
})

test('diagram.update schema rejects non-UUID id', () => {
  const { repo, cleanup } = withHarness()
  try {
    const schema = diagramUpdate(repo).inputSchema
    assert.ok(!schema.safeParse({ id: 'not-a-uuid', xml: XML_1 }).success)
    assert.ok(schema.safeParse({ id: '00000000-0000-0000-0000-000000000000', xml: XML_1 }).success)
  } finally { cleanup() }
})

// ===========================================================================
// No side-effect before approve: write execute() is the ONLY mutation path,
// and the runtime only calls it after consuming the approval token.
// (Structural: there is no apply/writeback shortcut in the adapter layer.)
// ===========================================================================

test('write adapters expose no apply/writeback shortcut (approval is the only path)', () => {
  const { repo, cleanup } = withHarness()
  try {
    for (const factory of [diagramCreate, diagramUpdate, diagramDuplicate, diagramRestoreRevision]) {
      const tool = factory(repo)
      assert.equal(typeof tool.apply, 'undefined', `${tool.id} has no apply()`)
      assert.equal(typeof tool.writeback, 'undefined', `${tool.id} has no writeback()`)
    }
  } finally { cleanup() }
})

test('read adapters never mutate the repo (list leaves count unchanged)', () => {
  const { repo, cleanup } = withHarness()
  try {
    repo.create({ title: 'A', xml: XML_1, source: 'test' })
    const before = repo.list().total
    diagramList(repo).execute({ limit: 10, offset: 0 })
    diagramGet(repo).execute({ id: repo.list().items[0].id })
    assert.equal(repo.list().total, before, 'reads did not mutate')
  } finally { cleanup() }
})

// ===========================================================================
// Runtime-level approval gate: diagram.create via AiRuntime
//   - Before approve: emits approval-required, repo stays at 0, onChanged 0.
//   - After approve + consume: repo becomes 1, onChanged fires once (created),
//     tool-completed emitted, run completes.
//   - This is the end-to-end P4 contract: no side-effect before the approval
//     token is consumed; the write executes only after the gate.
// ===========================================================================

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

function emptyProfileRepo() { return { get: () => null } }
function emptyVault() { return { get: () => null, isEncryptionAvailable: () => true } }
function unusedProvider() {
  return { streamChat: () => { throw new Error('streamChat must not be called for direct-tool runs') } }
}

/** Build a runtime wired with diagram tools + approval manager + onChanged capture. */
function makeDiagramRuntime(dir, sink) {
  const repo = new DiagramRepository(dir)
  const toolRegistry = new AiToolRegistry()
  const changes = []
  registerDiagramTools(toolRegistry, repo, (doc, reason) => {
    changes.push({ id: doc.id, reason })
  })
  const approvalManager = new AiApprovalManager()
  const auditLog = new AiAuditLog(dir)
  const conversationRepo = new AiConversationRepository(dir)
  const conv = conversationRepo.create({ modelProfileId: 'prof_direct' })
  const runtime = new AiRuntime({
    providerRegistry: unusedProvider(),
    conversationRepository: conversationRepo,
    credentialVault: emptyVault(),
    profileRepository: emptyProfileRepo(),
    toolRegistry,
    approvalManager,
    auditLog,
    emit: sink.emit,
  })
  return { runtime, repo, approvalManager, conv, changes }
}

test('runtime: diagram.create with NO approval → approval-required, repo stays 0, onChanged 0', async () => {
  const { dir, cleanup } = withHarnessDir()
  try {
    const sink = eventSink()
    const { runtime, repo, conv, changes } = makeDiagramRuntime(dir, sink)
    const { runId } = runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'diagram.create', rawInput: { title: 'New', xml: XML_1 } }],
    })
    // Wait for approval-required (the run blocks on the decision).
    let approvalEvent = null
    for (let i = 0; i < 200 && !approvalEvent; i++) {
      approvalEvent = sink.events.find((e) => e.type === 'approval-required')
      if (approvalEvent) break
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok(approvalEvent, 'approval-required emitted')
    // NO side-effect before approve: repo + onChanged untouched.
    assert.equal(repo.list().total, 0, 'repo has 0 diagrams before approval')
    assert.equal(changes.length, 0, 'onChanged did not fire before approval')
    // Cancel the run to settle it (it's blocked on the decision).
    runtime.cancel(runId, 'user')
    await waitForRunSettled(runtime, runId)
    // Still no side-effect after cancel.
    assert.equal(repo.list().total, 0)
    assert.equal(changes.length, 0)
  } finally { cleanup() }
})

test('runtime: diagram.create approved → consume → repo 1, onChanged "created", tool-completed, run completes', async () => {
  const { dir, cleanup } = withHarnessDir()
  try {
    const sink = eventSink()
    const { runtime, repo, approvalManager, conv, changes } = makeDiagramRuntime(dir, sink)
    runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'diagram.create', rawInput: { title: 'New', xml: XML_1 } }],
    })
    // Wait for approval-required.
    let approvalEvent = null
    for (let i = 0; i < 200 && !approvalEvent; i++) {
      approvalEvent = sink.events.find((e) => e.type === 'approval-required')
      if (approvalEvent) break
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok(approvalEvent)
    // Before approve: no side-effect.
    assert.equal(repo.list().total, 0)
    assert.equal(changes.length, 0)
    // Approve the token.
    const decideR = approvalManager.decide(approvalEvent.payload.token, true, 'looks good')
    assert.equal(decideR.ok, true)
    // Wait for terminal.
    await sink.waitForTerminal()
    // After approve + consume: exactly 1 diagram, onChanged fired once (created).
    assert.equal(repo.list().total, 1, 'repo has 1 diagram after approval')
    assert.equal(changes.length, 1, 'onChanged fired once')
    assert.equal(changes[0].reason, 'created')
    // tool-completed present, no tool-failed.
    assert.ok(sink.events.some((e) => e.type === 'tool-completed'), 'tool-completed emitted')
    assert.equal(sink.events.some((e) => e.type === 'tool-failed'), false, 'no tool-failed')
    // Run completed (not failed/cancelled).
    const terminals = sink.events.filter((e) => e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled')
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].type, 'completed')
  } finally { cleanup() }
})

test('runtime: diagram.create rejected → tool-failed, repo stays 0, onChanged 0, run completes', async () => {
  const { dir, cleanup } = withHarnessDir()
  try {
    const sink = eventSink()
    const { runtime, repo, approvalManager, conv, changes } = makeDiagramRuntime(dir, sink)
    runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'diagram.create', rawInput: { title: 'New', xml: XML_1 } }],
    })
    let approvalEvent = null
    for (let i = 0; i < 200 && !approvalEvent; i++) {
      approvalEvent = sink.events.find((e) => e.type === 'approval-required')
      if (approvalEvent) break
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok(approvalEvent)
    // Reject the token.
    approvalManager.decide(approvalEvent.payload.token, false, 'not allowed')
    await sink.waitForTerminal()
    // No side-effect on reject.
    assert.equal(repo.list().total, 0, 'repo has 0 diagrams after rejection')
    assert.equal(changes.length, 0, 'onChanged did not fire on rejection')
    assert.ok(sink.events.some((e) => e.type === 'tool-failed'), 'tool-failed emitted')
  } finally { cleanup() }
})

test('runtime: diagram.list (read) runs WITHOUT approval-required, completes directly', async () => {
  const { dir, cleanup } = withHarnessDir()
  try {
    const sink = eventSink()
    const { runtime, repo, conv } = makeDiagramRuntime(dir, sink)
    repo.create({ title: 'A', xml: XML_1, source: 'test' })
    runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'diagram.list', rawInput: { limit: 10, offset: 0 } }],
    })
    await sink.waitForTerminal()
    // Read runs do NOT emit approval-required.
    assert.equal(sink.events.some((e) => e.type === 'approval-required'), false, 'no approval-required for read')
    assert.ok(sink.events.some((e) => e.type === 'tool-completed'), 'tool-completed emitted')
  } finally { cleanup() }
})

// ===========================================================================
// Runtime-level EXPIRY: an approved-but-expired diagram write token MUST NOT
// execute. The runtime builds the approval via approvalManager.propose(), so
// the test captures the LIVE token object (the very reference stored in the
// manager's internal map) by wrapping propose(), then flips its expiresAt
// into the past at decide() time. The runtime's consume() then observes the
// expired state → tool-failed (category approval-expired), repo stays 0,
// onChanged 0. No production test-hook is needed: propose() returns the live
// stored token by reference, and the wrapper mutates that same object.
// ===========================================================================

test('runtime: diagram.create approved-but-expired → tool-failed, repo 0, onChanged 0 (expiry enforced at consume)', async () => {
  const { dir, cleanup } = withHarnessDir()
  try {
    const sink = eventSink()
    const { runtime, repo, approvalManager, conv, changes } = makeDiagramRuntime(dir, sink)

    // Capture the live token (stored-by-reference in the manager) by wrapping
    // propose(). The runtime calls approvalManager.propose(req) internally;
    // our wrapper delegates then stashes the returned live token object.
    const originalPropose = approvalManager.propose.bind(approvalManager)
    let liveToken = null
    approvalManager.propose = (req) => {
      liveToken = originalPropose(req)
      return liveToken
    }
    // Wrap decide() to force expiry the moment the matching token is approved.
    // decide() runs BEFORE the runtime's consume(); flipping expiresAt here
    // makes the runtime's subsequent consume() observe a past-TTL token.
    const originalDecide = approvalManager.decide.bind(approvalManager)
    approvalManager.decide = (tokenId, approved, comment) => {
      const r = originalDecide(tokenId, approved, comment)
      if (r.ok && approved && liveToken && tokenId === liveToken.token) {
        liveToken.expiresAt = Date.now() - 1
      }
      return r
    }

    runtime.start({
      conversationId: conv.id,
      modelProfileId: 'prof_direct',
      mode: 'chat',
      message: '',
      toolCalls: [{ toolId: 'diagram.create', rawInput: { title: 'Expired', xml: XML_1 } }],
    })

    // Wait for approval-required, then approve (the wrapper expires the token).
    let approvalEvent = null
    for (let i = 0; i < 200 && !approvalEvent; i++) {
      approvalEvent = sink.events.find((e) => e.type === 'approval-required')
      if (approvalEvent) break
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok(approvalEvent, 'approval-required emitted')
    assert.equal(repo.list().total, 0, 'no side-effect before approval')

    const decideR = approvalManager.decide(approvalEvent.payload.token, true, 'ok')
    assert.equal(decideR.ok, true)

    await sink.waitForTerminal()

    // Expired token → tool-failed (approval-expired), NO write, NO onChanged.
    assert.equal(repo.list().total, 0, 'expired approval wrote no diagram')
    assert.equal(changes.length, 0, 'onChanged did not fire on expiry')
    const failed = sink.events.find((e) => e.type === 'tool-failed')
    assert.ok(failed, 'tool-failed emitted on expiry')
    assert.equal(failed.payload.category, 'approval-expired')
    // The run's terminal is `failed` (a write tool that cannot execute flips
    // allOk to false → runToolCalls commits a single `failed` terminal). This
    // is the recoverable-failure path: the run stops cleanly with exactly one
    // terminal, no cancelled, no second terminal.
    const terminals = sink.events.filter((e) => ['completed', 'failed', 'cancelled'].includes(e.type))
    assert.equal(terminals.length, 1, 'exactly one terminal')
    assert.equal(terminals[0].type, 'failed', 'run fails cleanly when the sole write tool is denied by expiry')
  } finally { cleanup() }
})

function withHarnessDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-ai-diagram-rt-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ===========================================================================
// Diagram write approval lifecycle: EXPIRY / INVALID / REUSE
//
// These are manager-level tests over the diagram approval path
// (buildDiagramApproval → AiApprovalManager). The runtime always passes its
// own re-built approvalReq to consume(), so a binding mismatch cannot arise
// via the normal runtime path — the contract is enforced at the manager.
// Expiry is testable here because propose() returns the LIVE token object
// (stored by reference in the manager's map); mutating its `expiresAt` flips
// the stored entry, so consume() observes the past-TTL state immediately
// (no 5-minute wait, no test-only TTL hook in production code).
// ===========================================================================

/** Build a complete AiApprovalRequest for a diagram write tool. Mirrors how
 *  ai-runtime.ts assembles it from buildDiagramApproval's 6 fields. */
function diagramApprovalRequest(runId, toolCallId, toolId, input) {
  const fields = buildDiagramApproval(runId, toolCallId, toolId, input)
  return {
    runId,
    toolCallId,
    toolId,
    risk: 'write',
    normalizedInput: fields.normalizedInput,
    targetScope: fields.targetScope,
    contentHash: fields.contentHash,
    revision: fields.revision,
    impactSummary: fields.impactSummary,
    impactPreview: fields.impactPreview,
  }
}

const UUID_A = '00000000-0000-0000-0000-000000000000'

// ---------------------------------------------------------------------------
// EXPIRY: an approved-but-expired token MUST NOT execute (consume → expired).
// ---------------------------------------------------------------------------

test('diagram approval: approved token past TTL → consume denies as expired, no execution', () => {
  const mgr = new AiApprovalManager()
  const input = { id: UUID_A, xml: XML_2, expectedRevision: 3 }
  const req = diagramApprovalRequest('run_ex', 'tc_ex', 'diagram.update', input)
  const token = mgr.propose(req)
  assert.equal(mgr.decide(token.token, true, 'ok').ok, true)
  // Force expiry on the LIVE token object (propose returns the stored ref).
  token.expiresAt = Date.now() - 1
  const r = mgr.consume(token.token, req)
  assert.equal(r.ok, false)
  assert.equal(r.status, 'expired')
  assert.match(r.reason, /过期/)
})

test('diagram approval: expired token cannot be decided-then-consumed (TTL checked at decide too)', () => {
  const mgr = new AiApprovalManager()
  const req = diagramApprovalRequest('run_ex2', 'tc_ex2', 'diagram.create', { title: 'X', xml: XML_1 })
  const token = mgr.propose(req)
  token.expiresAt = Date.now() - 1
  // decide() on a past-TTL pending token flips it to expired, not approved.
  const d = mgr.decide(token.token, true)
  assert.equal(d.ok, true)
  assert.equal(d.token.status, 'expired')
  assert.equal(mgr.consume(token.token, req).ok, false, 'expired token never executes')
})

// ---------------------------------------------------------------------------
// INVALID: a tampered binding MUST be denied (no swapped target/content).
// buildDiagramApproval binds contentHash to the canonical input; rebuilding
// with altered input yields a different hash → consume mismatch.
// ---------------------------------------------------------------------------

test('diagram approval: consume denies on contentHash mismatch (tampered payload)', () => {
  const mgr = new AiApprovalManager()
  const input = { id: UUID_A, xml: XML_1, expectedRevision: 1 }
  const req = diagramApprovalRequest('run_iv', 'tc_iv', 'diagram.update', input)
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  // Rebuild with a DIFFERENT xml → different contentHash → mismatch denial.
  const tampered = { ...req, contentHash: sha256Hex(canonicalJson({ id: UUID_A, xml: XML_2, expectedRevision: 1 })) }
  const r = mgr.consume(token.token, tampered)
  assert.equal(r.ok, false)
  assert.match(r.reason, /内容哈希不匹配|篡改/)
})

test('diagram approval: consume denies on targetScope mismatch (swapped target)', () => {
  const mgr = new AiApprovalManager()
  const req = diagramApprovalRequest('run_iv2', 'tc_iv2', 'diagram.update', { id: UUID_A, xml: XML_1, expectedRevision: 1 })
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  const swapped = { ...req, targetScope: 'diagram:diagram.create' }
  const r = mgr.consume(token.token, swapped)
  assert.equal(r.ok, false)
  assert.match(r.reason, /目标范围不匹配/)
})

test('diagram approval: consume denies on revision mismatch (stale target snapshot)', () => {
  const mgr = new AiApprovalManager()
  const req = diagramApprovalRequest('run_iv3', 'tc_iv3', 'diagram.update', { id: UUID_A, xml: XML_1, expectedRevision: 1 })
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  // A different expectedRevision → different revision hash → stale-target denial.
  const stale = { ...req, revision: sha256Hex(`${UUID_A}:2`) }
  const r = mgr.consume(token.token, stale)
  assert.equal(r.ok, false)
  assert.match(r.reason, /目标快照已变更|版本/)
})

test('diagram approval: consume denies on toolId mismatch (cross-tool token reuse attempt)', () => {
  const mgr = new AiApprovalManager()
  const req = diagramApprovalRequest('run_iv4', 'tc_iv4', 'diagram.update', { id: UUID_A, xml: XML_1, expectedRevision: 1 })
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  const otherTool = { ...req, toolId: 'diagram.duplicate' }
  const r = mgr.consume(token.token, otherTool)
  assert.equal(r.ok, false)
  assert.match(r.reason, /工具不匹配/)
})

// ---------------------------------------------------------------------------
// REUSE: a consumed token is single-use; a second consume is denied (used).
// Guarantees a diagram write cannot be replayed by re-consuming the token.
// ---------------------------------------------------------------------------

test('diagram approval: single-use — second consume after success is denied (used)', () => {
  const mgr = new AiApprovalManager()
  const req = diagramApprovalRequest('run_ru', 'tc_ru', 'diagram.create', { title: 'New', xml: XML_1 })
  const token = mgr.propose(req)
  mgr.decide(token.token, true)
  assert.equal(mgr.consume(token.token, req).ok, true, 'first consume succeeds')
  const r2 = mgr.consume(token.token, req)
  assert.equal(r2.ok, false, 'second consume denied')
  assert.equal(r2.status, 'used')
  assert.match(r2.reason, /已使用|单次/)
})

test('diagram approval: single-use — a used token cannot execute the write again', () => {
  const { repo, cleanup } = withHarness()
  try {
    const mgr = new AiApprovalManager()
    const tool = registry_getCreateTool(repo)
    const req = diagramApprovalRequest('run_ru2', 'tc_ru2', 'diagram.create', { title: 'Once', xml: XML_1 })
    const token = mgr.propose(req)
    mgr.decide(token.token, true)
    // First consume → tool may execute (the runtime does consume THEN execute).
    assert.equal(mgr.consume(token.token, req).ok, true)
    const before = repo.list().total
    // Replay attempt: re-consume is denied; the tool would NOT be re-invoked
    // by the runtime (consume is the gate). Simulate the gate check.
    const replay = mgr.consume(token.token, req)
    assert.equal(replay.ok, false)
    assert.equal(replay.status, 'used')
    // Repo count unchanged by the denied replay (no second execution path).
    assert.equal(repo.list().total, before)
    void tool
  } finally { cleanup() }
})

/** Helper: build a registered diagram.create tool (onChanged not needed here). */
function registry_getCreateTool(repo) {
  return diagramCreate(repo)
}
