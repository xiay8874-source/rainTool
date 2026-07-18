// Test-only stub for `node:http`, used by ai-drawio-service.test.mjs.
//
// The service calls `http.get({hostname, port, path, timeout}, cb)` to probe
// /zh and /drawio/index.html. The stub reads `probeResult` from the shared
// electron-drawio-stub state: when true, every probe resolves with a 200;
// when false, every probe resolves with a 503 (so probeHttp returns false,
// driving the START_TIMEOUT path).
//
// The stub mirrors the real http.get callback contract: cb receives a
// response object with `statusCode` and a `resume()` method (the service
// calls resume() to drain). Errors are not emitted (probes are best-effort).
//
// NEVER shipped — used only by tests/ai-drawio-service.test.mjs.

import { EventEmitter } from 'node:events'

// The stub state lives in the electron-drawio-stub module so tests configure
// it via setElectronStub({probeResult: ...}). We import the state lazily to
// avoid a circular import: the loader redirects `electron` to the stub, which
// is what the service imports; the http stub is a separate redirect that also
// reads the shared state. We use a dynamic import to break the cycle.
let stateProxy = null
async function getState() {
  if (!stateProxy) {
    // The electron-drawio-stub is at the same directory; resolve relative to
    // this module's URL.
    const stubUrl = new URL('./electron-drawio-stub.mjs', import.meta.url).href
    const mod = await import(stubUrl)
    stateProxy = mod.__testState
  }
  return stateProxy
}

class FakeResponse extends EventEmitter {
  constructor(statusCode) {
    super()
    this.statusCode = statusCode
    this.headers = {}
  }
  resume() { /* drain — no body to consume */ }
}

export function get(options, callback) {
  // The service passes {hostname, port, path, timeout}. We ignore the path
  // (both /zh and /drawio/index.html use the same probeResult toggle).
  const req = new EventEmitter()
  // Defer the callback so the service registers handlers synchronously first.
  queueMicrotask(async () => {
    const state = await getState()
    const statusCode = state.probeResult ? 200 : 503
    const res = new FakeResponse(statusCode)
    callback(res)
    // The service also attaches an 'error' listener; we don't emit any.
  })
  // The service attaches 'timeout' and 'error' listeners. No timeouts/errors
  // in the stub — the probeResult alone controls the outcome.
  req.setTimeout = () => {}
  req.destroy = () => {}
  req.on = EventEmitter.prototype.on.bind(req)
  req.once = EventEmitter.prototype.once.bind(req)
  return req
}

export default { get }
