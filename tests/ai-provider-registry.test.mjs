// Tests for the provider registry + OpenAI-compatible stream adapter.
//
// Covers plan §4.1 / P0 spike §5.3:
//   - Mock local streaming endpoint (no network): deltas arrive as text-delta
//     events, then a single `completed` terminal with the full finalText.
//   - EXACTLY ONE terminal event: completed OR failed, never both, never none.
//   - Stream error (HTTP non-2xx or SDK error) produces a single `failed`
//     terminal with a redacted error (the raw key never appears).
//   - Abort (runtime cancel) produces NO terminal from the provider; the
//     outcome is `aborted` with reason 'cancel'.
//   - Per-call timeout produces `aborted` with reason 'timeout'.
//   - P1 exposes NO tools: the request body to the mock has no `tools` field.

import assert from 'node:assert/strict'
import test from 'node:test'
import { AiProviderRegistry, redactSecrets } from '../dist-electron/ai-platform/ai-provider-registry.js'
import { mockFetch, TEST_PROFILE } from './fixtures/mock-openai-fetch.mjs'

const RAW_KEY = 'sk-test-secret-key-1234567890abcdef'

function makeRegistry(fetchImpl) {
  return new AiProviderRegistry({ fetch: fetchImpl })
}

function collector() {
  const events = []
  return {
    events,
    emit: (e) => events.push(e),
    sequence: { value: 1 },
    runId: 'run_test',
  }
}

function terminalTypes(events) {
  return events.filter((e) => e.type === 'completed' || e.type === 'failed' || e.type === 'cancelled')
}

test('streamChat emits ONLY text-delta events and returns completed outcome (no terminal)', async () => {
  const registry = makeRegistry(mockFetch({ deltas: ['Hello', ' world'] }))
  const c = collector()
  const outcome = await registry.streamChat({
    profile: TEST_PROFILE,
    apiKey: RAW_KEY,
    messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
    system: 'sys',
    abortSignal: new AbortController().signal,
    fetch: mockFetch({ deltas: ['Hello', ' world'] }),
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })

  assert.equal(outcome.kind, 'completed')
  assert.equal(outcome.finalText, 'Hello world')
  const deltas = c.events.filter((e) => e.type === 'text-delta')
  assert.equal(deltas.length, 2)
  assert.equal(deltas[0].payload.delta, 'Hello')
  assert.equal(deltas[1].payload.delta, ' world')
  // Provider NEVER emits a terminal — the runtime owns completed/failed/cancelled.
  assert.equal(terminalTypes(c.events).length, 0, 'provider emitted a terminal')
})

test('streamChat never sends a `tools` field in the request body (P1 has no tools)', async () => {
  let capturedBody = null
  const fetchImpl = mockFetch({
    deltas: ['ok'],
    onRequest: (_url, body) => { capturedBody = body },
  })
  const registry = makeRegistry(fetchImpl)
  const c = collector()
  await registry.streamChat({
    profile: TEST_PROFILE,
    apiKey: RAW_KEY,
    messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
    abortSignal: new AbortController().signal,
    fetch: fetchImpl,
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })
  assert.equal(capturedBody.tools, undefined)
  assert.equal(capturedBody.tool_choice, undefined)
  assert.equal(capturedBody.stream, true)
})

test('raw API key never appears in any emitted event or finalText', async () => {
  const registry = makeRegistry(mockFetch({ deltas: ['plain reply'] }))
  const c = collector()
  await registry.streamChat({
    profile: TEST_PROFILE,
    apiKey: RAW_KEY,
    messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
    abortSignal: new AbortController().signal,
    fetch: mockFetch({ deltas: ['plain reply'] }),
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })
  for (const e of c.events) {
    const json = JSON.stringify(e)
    assert.equal(json.includes(RAW_KEY), false, `raw key leaked in event ${e.type}`)
  }
})

test('HTTP error returns a failed outcome with redacted error; provider emits NO terminal', async () => {
  const fetchImpl = mockFetch({
    status: 500,
    errorBody: JSON.stringify({ error: { message: `bad key ${RAW_KEY}` } }),
  })
  const registry = makeRegistry(fetchImpl)
  const c = collector()
  const outcome = await registry.streamChat({
    profile: TEST_PROFILE,
    apiKey: RAW_KEY,
    messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
    abortSignal: new AbortController().signal,
    fetch: fetchImpl,
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.redactedError.includes(RAW_KEY), false)
  // Provider emits NO terminal; the runtime owns the single `failed`.
  assert.equal(terminalTypes(c.events).length, 0, 'provider emitted a terminal')
})

test('runtime abort produces NO provider terminal; outcome is aborted with reason cancel', async () => {
  // neverEnd keeps the stream open; only abort ends it. (A stronger
  // deadline-asserting variant runs in the dedicated no-hang test below.)
  const fetchImpl = mockFetch({ deltas: ['partial'], neverEnd: true, delayMs: 50 })
  const registry = makeRegistry(fetchImpl)
  const c = collector()
  const ac = new AbortController()
  const promise = registry.streamChat({
    profile: TEST_PROFILE,
    apiKey: RAW_KEY,
    messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
    abortSignal: ac.signal,
    fetch: fetchImpl,
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })
  // Abort mid-stream.
  setTimeout(() => ac.abort(), 80)
  const outcome = await promise
  assert.equal(outcome.kind, 'aborted')
  assert.equal(outcome.reason, 'cancel')
  const terminals = terminalTypes(c.events)
  assert.equal(terminals.length, 0, 'provider emitted a terminal on abort')
})

test('per-call timeout produces aborted with reason timeout', async () => {
  // neverEnd + long delay: the per-call timeout must fire. Assert completion
  // well within a deadline so a regression (ignored abort signal) hangs the
  // test instead of passing silently.
  const deadline = 5000
  const start = Date.now()
  const fetchImpl = mockFetch({ deltas: ['partial'], neverEnd: true, delayMs: 1000 })
  const registry = makeRegistry(fetchImpl)
  const c = collector()
  const outcome = await registry.streamChat({
    profile: TEST_PROFILE,
    apiKey: RAW_KEY,
    messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
    abortSignal: new AbortController().signal,
    fetch: fetchImpl,
    timeoutMs: 50,
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })
  const elapsed = Date.now() - start
  assert.equal(outcome.kind, 'aborted')
  assert.equal(outcome.reason, 'timeout')
  const terminals = terminalTypes(c.events)
  assert.equal(terminals.length, 0, 'provider emitted a terminal on timeout')
  assert.ok(elapsed < deadline, `timeout path took ${elapsed}ms, expected < ${deadline}ms`)
})

test('runtime abort mid-stream completes promptly with aborted/cancel (no hang)', async () => {
  const deadline = 5000
  const start = Date.now()
  const fetchImpl = mockFetch({ deltas: ['partial', 'more'], neverEnd: true, delayMs: 50 })
  const registry = makeRegistry(fetchImpl)
  const c = collector()
  const ac = new AbortController()
  const promise = registry.streamChat({
    profile: TEST_PROFILE,
    apiKey: RAW_KEY,
    messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
    abortSignal: ac.signal,
    fetch: fetchImpl,
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })
  setTimeout(() => ac.abort(), 120)
  const outcome = await promise
  const elapsed = Date.now() - start
  assert.equal(outcome.kind, 'aborted')
  assert.equal(outcome.reason, 'cancel')
  assert.equal(terminalTypes(c.events).length, 0, 'provider emitted a terminal on abort')
  assert.ok(elapsed < deadline, `abort path took ${elapsed}ms, expected < ${deadline}ms`)
})

test('redactSecrets strips sk- keys, bearer tokens, and long hex/base64 runs', () => {
  const raw = `error: request failed with sk-${'a'.repeat(40)} and Bearer abc.def.ghi token ${'x'.repeat(50)}`
  const redacted = redactSecrets(raw)
  assert.equal(redacted.includes('sk-aaaa'), false)
  assert.equal(redacted.includes('Bearer abc'), false)
  assert.equal(redacted.includes('x'.repeat(50)), false)
  assert.ok(redacted.includes('sk-••••'))
  assert.ok(redacted.includes('Bearer ••••'))
})

test('ollama profile resolves to the loopback base URL when no override is set', async () => {
  let requestedUrl = null
  const fetchImpl = async (url, init) => {
    requestedUrl = String(url)
    return mockFetch({ deltas: ['ok'] })(url, init)
  }
  const registry = makeRegistry(fetchImpl)
  const c = collector()
  const ollamaProfile = { ...TEST_PROFILE, providerId: 'ollama', baseUrl: undefined }
  await registry.streamChat({
    profile: ollamaProfile,
    apiKey: '',
    messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
    abortSignal: new AbortController().signal,
    fetch: fetchImpl,
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })
  assert.ok(requestedUrl.startsWith('http://127.0.0.1:11434/v1'), `unexpected ollama url: ${requestedUrl}`)
})

test('tool-role messages are skipped before being sent to the SDK (P1 has no tools)', async () => {
  let capturedBody = null
  const fetchImpl = mockFetch({
    deltas: ['ok'],
    onRequest: (_url, body) => { capturedBody = body },
  })
  const registry = makeRegistry(fetchImpl)
  const c = collector()
  await registry.streamChat({
    profile: TEST_PROFILE,
    apiKey: RAW_KEY,
    messages: [
      { id: 'm1', role: 'user', at: 0, text: 'hi' },
      { id: 'm2', role: 'tool', at: 0, text: 'should-be-skipped' },
      { id: 'm3', role: 'assistant', at: 0, text: 'hello' },
    ],
    abortSignal: new AbortController().signal,
    fetch: fetchImpl,
    emit: c.emit,
    runId: c.runId,
    sequence: c.sequence,
  })
  const roles = capturedBody.messages.map((m) => m.role)
  assert.deepEqual(roles, ['user', 'assistant'])
  assert.equal(roles.includes('tool'), false)
})

// Regression: the ai@5 SDK's streamText defaults onError to
// console.error(error), which prints the full APICallError — including the
// request body/headers carrying `Authorization: Bearer sk-...` — to
// stdout/stderr whenever the stream errors (HTTP non-2xx, network failure).
// The provider MUST override onError so the raw key never reaches logs, even
// though the returned outcome is separately redacted. This test captures
// console.error, console.warn, console.log, and stdout/stderr writes around
// an HTTP-500 stream and asserts none of them contains the raw key.
test('streamChat HTTP error does NOT log the raw key (onError suppressed, no leak to stdout/stderr)', async () => {
  const fetchImpl = mockFetch({
    status: 500,
    // Embed the raw key in the error body to mimic the SDK surfacing the
    // request context in the APICallError — if onError fired with the default
    // logger, this string would land in console.error/stderr.
    errorBody: JSON.stringify({ error: { message: `upstream rejected ${RAW_KEY}` } }),
  })
  const registry = makeRegistry(fetchImpl)
  const c = collector()

  const captured = []
  const origConsoleError = console.error
  const origConsoleWarn = console.warn
  const origConsoleLog = console.log
  const origConsoleInfo = console.info
  console.error = (...args) => { captured.push(['error', args]) }
  console.warn = (...args) => { captured.push(['warn', args]) }
  console.log = (...args) => { captured.push(['log', args]) }
  console.info = (...args) => { captured.push(['info', args]) }

  // Also tap stdout/stderr at the stream level — the SDK's default logger
  // writes through process.stderr in some Node versions.
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  const stdoutChunks = []
  const stderrChunks = []
  process.stdout.write = (chunk, ...rest) => {
    stdoutChunks.push(String(chunk))
    return origStdoutWrite(chunk, ...rest)
  }
  process.stderr.write = (chunk, ...rest) => {
    stderrChunks.push(String(chunk))
    return origStderrWrite(chunk, ...rest)
  }

  try {
    const outcome = await registry.streamChat({
      profile: TEST_PROFILE,
      apiKey: RAW_KEY,
      messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
      abortSignal: new AbortController().signal,
      fetch: fetchImpl,
      emit: c.emit,
      runId: c.runId,
      sequence: c.sequence,
    })
    // Sanity: the stream did error and we got a failed outcome — so the SDK
    // path that would have triggered onError actually ran.
    assert.equal(outcome.kind, 'failed')
    assert.equal(outcome.redactedError.includes(RAW_KEY), false, 'outcome leaked the raw key')
  } finally {
    console.error = origConsoleError
    console.warn = origConsoleWarn
    console.log = origConsoleLog
    console.info = origConsoleInfo
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
  }

  // The SDK's default onError (console.error) must be suppressed. If any
  // console method fired, its args must not contain the raw key.
  for (const [label, args] of captured) {
    const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' ')
    assert.equal(
      text.includes(RAW_KEY), false,
      `console.${label} leaked the raw key: ${text.slice(0, 200)}`,
    )
  }
  // Belt-and-suspenders: the raw key must not appear in stdout/stderr either.
  const stdoutText = stdoutChunks.join('')
  const stderrText = stderrChunks.join('')
  assert.equal(stdoutText.includes(RAW_KEY), false, `stdout leaked the raw key: ${stdoutText.slice(0, 200)}`)
  assert.equal(stderrText.includes(RAW_KEY), false, `stderr leaked the raw key: ${stderrText.slice(0, 200)}`)
})

// Stronger variant: even when the error body does NOT echo the key, the SDK's
// APICallError still embeds the request headers (Authorization: Bearer ...).
// This test confirms no Authorization header with the raw key is logged.
test('streamChat HTTP error does NOT log an Authorization header carrying the raw key', async () => {
  const fetchImpl = mockFetch({
    status: 500,
    errorBody: JSON.stringify({ error: { message: 'generic upstream error' } }),
  })
  const registry = makeRegistry(fetchImpl)
  const c = collector()

  const captured = []
  const origConsoleError = console.error
  const origConsoleWarn = console.warn
  const origConsoleLog = console.log
  console.error = (...args) => { captured.push(args) }
  console.warn = (...args) => { captured.push(args) }
  console.log = (...args) => { captured.push(args) }

  const origStderrWrite = process.stderr.write.bind(process.stderr)
  const stderrChunks = []
  process.stderr.write = (chunk, ...rest) => {
    stderrChunks.push(String(chunk))
    return origStderrWrite(chunk, ...rest)
  }

  try {
    const outcome = await registry.streamChat({
      profile: TEST_PROFILE,
      apiKey: RAW_KEY,
      messages: [{ id: 'm1', role: 'user', at: 0, text: 'hi' }],
      abortSignal: new AbortController().signal,
      fetch: fetchImpl,
      emit: c.emit,
      runId: c.runId,
      sequence: c.sequence,
    })
    assert.equal(outcome.kind, 'failed')
  } finally {
    console.error = origConsoleError
    console.warn = origConsoleWarn
    console.log = origConsoleLog
    process.stderr.write = origStderrWrite
  }

  const authPattern = new RegExp(`Bearer\\s+${RAW_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  for (const args of captured) {
    const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' ')
    assert.equal(authPattern.test(text), false, `console call leaked Authorization header: ${text.slice(0, 200)}`)
    assert.equal(text.includes(RAW_KEY), false, `console call leaked raw key: ${text.slice(0, 200)}`)
  }
  const stderrText = stderrChunks.join('')
  assert.equal(authPattern.test(stderrText), false, `stderr leaked Authorization header: ${stderrText.slice(0, 200)}`)
  assert.equal(stderrText.includes(RAW_KEY), false, `stderr leaked raw key: ${stderrText.slice(0, 200)}`)
})
