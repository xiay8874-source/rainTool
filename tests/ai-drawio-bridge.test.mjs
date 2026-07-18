// Unit tests for the AI Draw.io bridge-message classifier.
//
// The renderer's iframe handoff relies on correctly classifying postMessage
// events from the embedded Draw.io bridge (protocol `raintool-diagram-v1`).
// The classifier is a pure function — no DOM, no React — so we can test every
// branch directly. These tests are the regression for:
//   - protocol mismatch → ignore (defense against stray postMessage senders).
//   - raintool:diagram-ready → ready (the bounded handoff signal).
//   - raintool:diagram-autosave → only honored for the CURRENT document; a
//     stale autosave from a previous document is ignored (no overwrite).
//   - raintool:diagram-export-result → only honored for a PENDING request id;
//     a stray/unsolicited result is ignored.
//   - raintool:legacy-response → idempotent (second response ignored).
//   - unknown/malformed messages → ignore (forward-compatible).

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Transpile src/components/tools/ai-drawio-bridge.ts → temp ESM. The module
// is pure (no React, no DOM) so it transpiles cleanly to a Node-runnable ESM
// file. The diagram-types import is type-only and erased by esbuild.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'raintool-drawio-bridge-'))
const outPath = path.join(tmpDir, 'ai-drawio-bridge.mjs')
await build({
  entryPoints: ['src/components/tools/ai-drawio-bridge.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outPath,
  logLevel: 'silent',
})

const {
  BRIDGE_PROTOCOL,
  classifyBridgeMessage,
} = await import(outPath + '?t=' + Date.now())

test.after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function ctx(overrides) {
  return {
    currentDocumentId: 'diag_1',
    pendingExportRequestIds: new Set(['req_1']),
    legacyMigrationDone: false,
    ...overrides,
  }
}

test('non-bridge protocol is ignored (defense against stray senders)', () => {
  const action = classifyBridgeMessage({ protocol: 'something-else', type: 'raintool:diagram-ready' }, ctx())
  assert.equal(action.kind, 'ignore')
})

test('null/undefined message is ignored', () => {
  assert.equal(classifyBridgeMessage(null, ctx()).kind, 'ignore')
  assert.equal(classifyBridgeMessage(undefined, ctx()).kind, 'ignore')
})

test('raintool:diagram-ready → ready action (the bounded handoff signal)', () => {
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:diagram-ready' },
    ctx(),
  )
  assert.equal(action.kind, 'ready')
})

test('raintool:diagram-autosave honored for the CURRENT document', () => {
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:diagram-autosave', diagramId: 'diag_1', xml: '<mxGraphModel/>' },
    ctx(),
  )
  assert.equal(action.kind, 'autosave')
  if (action.kind === 'autosave') {
    assert.equal(action.diagramId, 'diag_1')
    assert.equal(action.xml, '<mxGraphModel/>')
  }
})

test('raintool:diagram-autosave IGNORED for a stale document id (no overwrite)', () => {
  // Regression: after switching tabs/documents, a late autosave from the
  // previous document must NOT overwrite the current one. The classifier
  // compares message.diagramId against ctx.currentDocumentId.
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:diagram-autosave', diagramId: 'diag_OLD', xml: '<old/>' },
    ctx({ currentDocumentId: 'diag_1' }),
  )
  assert.equal(action.kind, 'ignore')
})

test('raintool:diagram-autosave with missing diagramId or xml is ignored', () => {
  assert.equal(
    classifyBridgeMessage(
      { protocol: BRIDGE_PROTOCOL, type: 'raintool:diagram-autosave', xml: '<x/>' },
      ctx(),
    ).kind,
    'ignore',
  )
  assert.equal(
    classifyBridgeMessage(
      { protocol: BRIDGE_PROTOCOL, type: 'raintool:diagram-autosave', diagramId: 'diag_1' },
      ctx(),
    ).kind,
    'ignore',
  )
})

test('raintool:diagram-export-result honored for a PENDING request id', () => {
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:diagram-export-result', requestId: 'req_1', data: 'base64-png' },
    ctx(),
  )
  assert.equal(action.kind, 'export-result')
  if (action.kind === 'export-result') {
    assert.equal(action.requestId, 'req_1')
    assert.equal(action.data, 'base64-png')
    assert.equal(action.error, undefined)
  }
})

test('raintool:diagram-export-result with empty data → error surface', () => {
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:diagram-export-result', requestId: 'req_1' },
    ctx(),
  )
  assert.equal(action.kind, 'export-result')
  if (action.kind === 'export-result') {
    assert.equal(action.data, undefined)
    assert.equal(action.error, 'Draw.io 未返回导出数据')
  }
})

test('raintool:diagram-export-result IGNORED for an unknown request id (no stray resolve)', () => {
  // A stray/unsolicited export result (e.g. from a previous frame load) must
  // not resolve an export that wasn't requested. The classifier checks the
  // requestId against ctx.pendingExportRequestIds.
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:diagram-export-result', requestId: 'req_UNKNOWN', data: 'x' },
    ctx(),
  )
  assert.equal(action.kind, 'ignore')
})

test('raintool:legacy-response honored when migration has not run', () => {
  const items = [{ id: 'old_1', title: 'Legacy', xml: '<x/>', source: 'legacy' }]
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:legacy-response', items },
    ctx({ legacyMigrationDone: false }),
  )
  assert.equal(action.kind, 'legacy-response')
  if (action.kind === 'legacy-response') {
    assert.equal(action.items.length, 1)
    assert.equal(action.items[0].id, 'old_1')
  }
})

test('raintool:legacy-response IGNORED when migration already ran (idempotent)', () => {
  // Regression: a frame reload re-posts legacy-response; the renderer must
  // not re-migrate (would duplicate diagrams). The classifier's
  // legacyMigrationDone guard is the first line of defense; the renderer
  // also sets a localStorage flag, but the classifier stays pure.
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:legacy-response', items: [{ id: 'x', title: 't', xml: '<x/>', source: 'legacy' }] },
    ctx({ legacyMigrationDone: true }),
  )
  assert.equal(action.kind, 'ignore')
})

test('raintool:legacy-response with non-array items is ignored', () => {
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:legacy-response', items: undefined },
    ctx({ legacyMigrationDone: false }),
  )
  assert.equal(action.kind, 'ignore')
})

test('unknown message type is ignored (forward-compatible)', () => {
  // The bridge may add new message types later; the renderer must not crash
  // or misinterpret them. Unknown types → ignore.
  const action = classifyBridgeMessage(
    { protocol: BRIDGE_PROTOCOL, type: 'raintool:some-future-message' },
    ctx(),
  )
  assert.equal(action.kind, 'ignore')
})

test('missing type is ignored', () => {
  const action = classifyBridgeMessage({ protocol: BRIDGE_PROTOCOL }, ctx())
  assert.equal(action.kind, 'ignore')
})
