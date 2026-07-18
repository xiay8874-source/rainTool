// Test-only Electron shim tailored for ai-drawio-service.ts.
//
// The service imports from `electron`: `app`, `utilityProcess`, and (for the
// shutdown path) `process.resourcesPath`. Under plain Node (node:test), the
// real Electron module is unavailable, so we register a resolve hook that
// maps bare `electron` to this file. The shim exposes a controllable
// `utilityProcess.fork` + `app.isPackaged` + `app.getAppPath` +
// `process.resourcesPath` + http/net probe results so each test can drive a
// specific lifecycle path (READY / START_TIMEOUT / START_FAILED /
// MISSING_RESOURCE / PORT_IN_USE) without spawning real processes or opening
// real sockets.
//
// NEVER shipped — used only by tests/ai-drawio-service.test.mjs.

import { EventEmitter } from 'node:events'

// Default stub state; tests override via setElectronStub().
const state = {
  appPackaged: false,
  appPath: '/raintool-test',
  resourcesPath: '/raintool-test-resources',
  // What the http probe returns (both /zh and /drawio/index.html).
  probeResult: false,
  // What net.createConnection returns (port already in use?).
  portListening: false,
  // What utilityProcess.fork returns: 'runnable' (stays alive), 'exit'
  // (exits immediately), 'error' (emits error).
  forkResult: 'runnable',
}

export function setElectronStub(overrides) {
  Object.assign(state, overrides)
}

// A fake utility process that emits stdout/stderr/exit/error events per the
// configured forkResult. The service wires stdout/stderr→rememberLog and
// exit→exited flag; we drive those from here.
class FakeUtilityProcess extends EventEmitter {
  constructor(forkResult) {
    super()
    this.pid = 12345
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.killed = false
    this._forkResult = forkResult
    // Defer the exit/error emission so the service has a chance to register
    // listeners (the service registers them synchronously after fork returns).
    queueMicrotask(() => {
      if (forkResult === 'exit') {
        this.stderr.emit('data', Buffer.from('fake child exited'))
        this.emit('exit', 1)
      } else if (forkResult === 'error') {
        this.emit('error', 'fake-error', 'fake-location')
      }
      // 'runnable' → stays alive; the service's waitUntilReady loop probes
      // HTTP and eventually times out (probeResult controls the probe).
    })
  }
  kill() {
    if (this.killed) return true
    this.killed = true
    // Emit exit so the service's stopAiDrawioServer resolves.
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

export const app = {
  isPackaged: false,
  getAppPath: () => state.appPath,
  // `process.resourcesPath` is read from `process`, not `app`, but the
  // service also references `app.isPackaged` to choose between packaged and
  // dev paths. We expose isPackaged as a getter so test overrides take
  // effect (a plain field would be stale after import).
  get: () => undefined,
}

// Re-export isPackaged as a live getter so setElectronStub({appPackaged:true})
// flips it after import.
Object.defineProperty(app, 'isPackaged', {
  get: () => state.appPackaged,
  configurable: true,
})

export const utilityProcess = {
  fork(_entry, _args, _options) {
    return new FakeUtilityProcess(state.forkResult)
  },
}

// The service reads `process.resourcesPath` for the packaged path. We expose
// a getter on a global `process` override. Since the service reads
// `process.resourcesPath` directly (not via app), we patch the global
// process.resourcesPath live. Save/restore around each test would be ideal,
// but the tests set it via setElectronStub before importing; we sync it here.
export function syncProcessResourcesPath() {
  try {
    Object.defineProperty(process, 'resourcesPath', {
      get: () => state.resourcesPath,
      configurable: true,
    })
  } catch {
    // Some Node builds don't allow redefining process.resourcesPath; in that
    // case the test must set it directly. We don't fail here.
  }
}
syncProcessResourcesPath()

// Expose a way for the test to read the live probe/port settings (the
// service imports http/net from node, so we can't stub those here directly;
// instead, the test stubs http/net via a separate mechanism below).
export const __testState = state
