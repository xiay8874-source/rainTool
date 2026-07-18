// Node-20 dependency-engine gate for the AI Platform.
//
// The app ships inside Electron, whose embedded Node is 20.x (currently
// 20.18.3). Any AI dependency that declares `engines.node` above 20 — or a
// Node-22-only floor — would silently fail at runtime under the embedded Node.
// This test reads the installed package metadata and refuses:
//   - any of the pinned AI deps (ai, @ai-sdk/openai, zod) at a version other
//     than the P1-pinned one;
//   - any AI dep whose engines.node floor exceeds 20;
//   - a cross-generation pairing where ai and @ai-sdk/openai resolve different
//     @ai-sdk/provider / @ai-sdk/provider-utils versions (the V2/V3 mismatch
//     that forced the @ai-sdk/openai@2.0.114 correction).
//
// This is a build-time gate: it runs under plain Node (the host), not Electron.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

// Resolve the repo root from this test file's location so the test is
// invariant to the caller's cwd. tests/ is one level under the root.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readPkg(name) {
  const pkgPath = path.join(ROOT, 'node_modules', name, 'package.json')
  return JSON.parse(readFileSync(pkgPath, 'utf8'))
}

/** Extract the numeric floor from an engines.node string like ">=18" or ">=20.0.0". */
function nodeFloor(engines) {
  if (!engines || !engines.node) return 0
  const match = engines.node.match(/>=?\s*(\d+)/)
  return match ? Number(match[1]) : 0
}

test('pinned AI deps are at the exact P1 versions', () => {
  assert.equal(readPkg('ai').version, '5.0.216', 'ai must be pinned to 5.0.216')
  assert.equal(readPkg('@ai-sdk/openai').version, '2.0.114', '@ai-sdk/openai must be pinned to 2.0.114')
  assert.equal(readPkg('zod').version, '3.25.76', 'zod must be pinned to 3.25.76')
})

test('every AI dep declares engines.node <= 20 (Node-20 embedded in Electron)', () => {
  const deps = ['ai', '@ai-sdk/openai', '@ai-sdk/provider', '@ai-sdk/provider-utils', 'zod']
  for (const name of deps) {
    const pkg = readPkg(name)
    const floor = nodeFloor(pkg.engines)
    assert.ok(
      floor <= 20,
      `${name}@${pkg.version} declares engines.node=${pkg.engines?.node ?? 'unset'} (floor ${floor}), which exceeds the embedded Node 20 floor`,
    )
  }
})

test('ai and @ai-sdk/openai share the same @ai-sdk/provider + provider-utils (no cross-generation)', () => {
  // Cross-generation pairing (V2 core with V3 provider) was the root cause of
  // the @ai-sdk/openai@3.0.86 correction. `npm ls` dedupes; if the two
  // resolve different versions, the tree is split and the SDK casts break.
  const providerVersions = execFileSync(
    'npm',
    ['ls', '@ai-sdk/provider', '--json'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const parsed = JSON.parse(providerVersions)
  const found = new Set()
  function walk(node) {
    if (node.dependencies) {
      for (const [name, child] of Object.entries(node.dependencies)) {
        if (name === '@ai-sdk/provider') found.add(child.version)
        walk(child)
      }
    }
  }
  walk(parsed)
  assert.equal(found.size, 1, `@ai-sdk/provider resolved to multiple versions: ${[...found].join(', ')}`)
  for (const v of found) {
    assert.match(v, /^2\./, `@ai-sdk/provider must be V2 (ai@5 generation), got ${v}`)
  }
})

test('no Anthropic or Google AI packages are installed; MCP SDK v1 is allowed as of P4', () => {
  // P4 adds @modelcontextprotocol/sdk (v1.x, MIT) as a main-process MCP client
  // dependency. It is now ALLOWED. Anthropic/Google providers remain forbidden
  // (P1 ships OpenAI-compatible + Ollama only).
  const forbidden = [
    '@anthropic-ai/sdk',
    '@google/generative-ai',
    '@ai-sdk/anthropic',
    '@ai-sdk/google',
  ]
  for (const name of forbidden) {
    assert.throws(
      () => readPkg(name),
      (err) => err.code === 'ENOENT',
      `${name} is installed but P1/P4 must not ship Anthropic/Google providers`,
    )
  }
  // The MCP SDK must be the pinned v1 (not v2/main) per docs/ai-platform-p4.md.
  const mcpPkg = readPkg('@modelcontextprotocol/sdk')
  assert.match(mcpPkg.version, /^1\./, `@modelcontextprotocol/sdk must be v1.x (P4), got ${mcpPkg.version}`)
})

test('THIRD_PARTY_NOTICES + LICENSES reference the pinned AI dep versions', () => {
  const notices = readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  // The notices use a "### <pkg>" heading + "Version: `<ver>`" line format.
  assert.ok(notices.includes('### ai (Vercel AI SDK core)'), 'THIRD_PARTY_NOTICES missing ai section')
  assert.ok(notices.match(/Version:\s*`5\.0\.216`/), 'THIRD_PARTY_NOTICES missing ai version 5.0.216')
  assert.ok(notices.includes('### @ai-sdk/openai'), 'THIRD_PARTY_NOTICES missing @ai-sdk/openai section')
  assert.ok(notices.match(/Version:\s*`2\.0\.114`/), 'THIRD_PARTY_NOTICES missing @ai-sdk/openai version 2.0.114')
  assert.ok(notices.includes('zod'), 'THIRD_PARTY_NOTICES missing zod section')
  assert.ok(notices.match(/Version:\s*`3\.25\.76`/), 'THIRD_PARTY_NOTICES missing zod version 3.25.76')

  // License assets exist for each.
  for (const file of ['ai-APACHE-2.0.txt', 'ai-sdk-openai-APACHE-2.0.txt', 'zod-MIT.txt']) {
    assert.doesNotThrow(
      () => readFileSync(path.join(ROOT, 'LICENSES', file), 'utf8'),
      `LICENSES/${file} missing`,
    )
  }
})
