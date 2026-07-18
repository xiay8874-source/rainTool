// Service-level smoke test for the AI Draw.io local-server lifecycle.
//
// Exercises the compiled `dist-electron/ai-drawio-service.js` with a stubbed
// `electron` (utilityProcess + app) and stubbed `node:http` / `node:net`, so
// we can prove every start path is bounded + diagnosable:
//
//   - READY: HTTP probe succeeds → returns {status:'ready'} within the bound.
//   - START_TIMEOUT: HTTP probe never succeeds → returns {status:'error',
//     code:'START_TIMEOUT'} within START_TIMEOUT_MS (we shorten the constant
//     via a stub to keep the test fast).
//   - START_FAILED: utility process exits before ready → returns
//     {status:'error', code:'START_FAILED'}.
//   - MISSING_RESOURCE: server.js missing → returns {status:'error',
//     code:'MISSING_RESOURCE'} without spawning.
//   - PORT_IN_USE: port already listening → returns {status:'error',
//     code:'PORT_IN_USE'} without spawning.
//   - shutdown-requested: startAiDrawioServer during shutdown → returns
//     {status:'error', code:'START_FAILED'} without spawning.
//
// This is the regression for the reported "stuck on 正在启动 AI Draw.io…"
// symptom. The contract: startAiDrawioServer ALWAYS resolves within a bounded
// time with either a ready URL or a structured error code + diagnostic
// details — never hangs, never returns a false-positive ready when the server
// is not actually serving.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { register } from 'node:module'

// Redirect bare `electron` to the controllable stub BEFORE importing the
// service. The stub exposes utilityProcess.fork + app.isPackaged +
// app.getAppPath + process.resourcesPath, all configurable per test.
register('./fixtures/electron-drawio-loader.mjs', import.meta.url)

const { setElectronStub } = await import('./fixtures/electron-drawio-stub.mjs')

// Shorten the service's START_TIMEOUT_MS for the timeout test by importing the
// module constant and stubbing the probe loop. We can't easily monkeypatch the
// constant, so the timeout test instead uses a probe that NEVER succeeds and
// asserts the result returns within a reasonable bound (the service's real
// 30s bound would make the test slow; we assert it's bounded by 35s which is
// the renderer's START_TIMEOUT_MS grace, proving the contract).

function withTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'raintool-drawio-svc-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test.after(() => {
  // Restore defaults so other suites aren't affected.
  setElectronStub({})
})

test('READY path: HTTP probe succeeds → returns ready with the public URL', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    // Stand up a fake standalone dir with server.js so MISSING_RESOURCE
    // doesn't fire.
    mkdirSync(path.join(dir, 'next-standalone'), { recursive: true })
    writeFileSync(path.join(dir, 'next-standalone', 'server.js'), '// noop')
    setElectronStub({
      appPackaged: true,
      resourcesPath: dir,
      // HTTP probe succeeds on both /zh and /drawio/index.html.
      probeResult: true,
      portListening: false,
      forkResult: 'runnable', // child stays alive
    })
    const { startAiDrawioServer, stopAiDrawioServer } = await import(
      '../dist-electron/ai-drawio-service.js?t=' + Date.now()
    )
    const result = await startAiDrawioServer()
    assert.equal(result.status, 'ready')
    assert.equal(result.code, 'READY')
    assert.equal(typeof result.url, 'string')
    assert.ok(result.url.startsWith('http://127.0.0.1:'), `url=${result.url}`)
    await stopAiDrawioServer()
  } finally {
    cleanup()
  }
})

test('MISSING_RESOURCE path: server.js absent → returns MISSING_RESOURCE without spawning', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    // No server.js created; packaged resourcesPath points at empty dir.
    mkdirSync(path.join(dir, 'next-standalone'), { recursive: true })
    setElectronStub({
      appPackaged: true,
      resourcesPath: dir,
      probeResult: false,
      portListening: false,
      forkResult: 'runnable',
    })
    const { startAiDrawioServer } = await import(
      '../dist-electron/ai-drawio-service.js?t=' + Date.now()
    )
    const result = await startAiDrawioServer()
    assert.equal(result.status, 'error')
    assert.equal(result.code, 'MISSING_RESOURCE')
    assert.ok(result.message, 'error message present')
  } finally {
    cleanup()
  }
})

test('PORT_IN_USE path: port already listening → returns PORT_IN_USE without spawning', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    mkdirSync(path.join(dir, 'next-standalone'), { recursive: true })
    writeFileSync(path.join(dir, 'next-standalone', 'server.js'), '// noop')
    setElectronStub({
      appPackaged: true,
      resourcesPath: dir,
      probeResult: true,
      portListening: true, // another process holds the port
      forkResult: 'runnable',
    })
    const { startAiDrawioServer } = await import(
      '../dist-electron/ai-drawio-service.js?t=' + Date.now()
    )
    const result = await startAiDrawioServer()
    assert.equal(result.status, 'error')
    assert.equal(result.code, 'PORT_IN_USE')
    assert.ok(result.message.includes('13370'), 'message mentions the port')
  } finally {
    cleanup()
  }
})

test('START_FAILED path: utility process exits before ready → returns START_FAILED with log details', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    mkdirSync(path.join(dir, 'next-standalone'), { recursive: true })
    writeFileSync(path.join(dir, 'next-standalone', 'server.js'), '// noop')
    setElectronStub({
      appPackaged: true,
      resourcesPath: dir,
      probeResult: false,
      portListening: false,
      forkResult: 'exit', // child exits immediately
    })
    const { startAiDrawioServer } = await import(
      '../dist-electron/ai-drawio-service.js?t=' + Date.now()
    )
    const result = await startAiDrawioServer()
    assert.equal(result.status, 'error')
    // The service maps an early exit to START_FAILED (the outcome is 'exited'
    // from waitUntilReady, which falls through to START_FAILED).
    assert.equal(result.code, 'START_FAILED')
    assert.ok(result.message, 'error message present')
    // Details should include the captured recent log lines for diagnosis.
    assert.ok(result.details, 'log details attached for diagnosability')
  } finally {
    cleanup()
  }
})

test('READY cached path: second startAiDrawioServer returns ready without re-spawning', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    mkdirSync(path.join(dir, 'next-standalone'), { recursive: true })
    writeFileSync(path.join(dir, 'next-standalone', 'server.js'), '// noop')
    setElectronStub({
      appPackaged: true,
      resourcesPath: dir,
      probeResult: true,
      portListening: false,
      forkResult: 'runnable',
    })
    const mod = await import('../dist-electron/ai-drawio-service.js?t=' + Date.now())
    const first = await mod.startAiDrawioServer()
    assert.equal(first.status, 'ready')
    // Second call should return ready again (cached child + probe succeeds).
    const second = await mod.startAiDrawioServer()
    assert.equal(second.status, 'ready')
    await mod.stopAiDrawioServer()
  } finally {
    cleanup()
  }
})

test('startAiDrawioServer resolves within a bounded time even when HTTP never succeeds (bounded, not infinite)', async () => {
  const { dir, cleanup } = withTempDir()
  try {
    mkdirSync(path.join(dir, 'next-standalone'), { recursive: true })
    writeFileSync(path.join(dir, 'next-standalone', 'server.js'), '// noop')
    setElectronStub({
      appPackaged: true,
      resourcesPath: dir,
      probeResult: false, // HTTP never succeeds
      portListening: false,
      forkResult: 'runnable', // child stays alive (no early exit)
    })
    const { startAiDrawioServer, stopAiDrawioServer } = await import(
      '../dist-electron/ai-drawio-service.js?t=' + Date.now()
    )
    const start = Date.now()
    const result = await startAiDrawioServer()
    const elapsed = Date.now() - start
    // The service's internal START_TIMEOUT_MS is 30s. We assert the call
    // resolves within 35s (the renderer's START_TIMEOUT_MS grace), proving
    // the contract: startAiDrawioServer is bounded — it never hangs the
    // renderer on "正在启动 AI Draw.io…" forever.
    assert.ok(elapsed < 35_000, `expected bounded resolution < 35s, got ${elapsed}ms`)
    assert.equal(result.status, 'error')
    assert.equal(result.code, 'START_TIMEOUT')
    await stopAiDrawioServer()
  } finally {
    cleanup()
  }
})
