// Test-only Electron shim.
//
// The AI credential vault imports `safeStorage` from 'electron'. Under plain
// Node (node:test), the real Electron module is unavailable, so we register a
// resolve/load hook that maps bare 'electron' to this file. The shim exposes a
// controllable safeStorage so tests can flip encryption availability and
// verify the no-plaintext-fallback path without a keychain.
//
// NEVER shipped — used only by tests under tests/.

const store = new Map() // ciphertext buffer keyed by a stable test key

export const safeStorage = {
  // Configurable from tests via setEncryptionAvailable().
  _available: true,
  isEncryptionAvailable() {
    return this._available
  },
  encryptString(plain) {
    // Deterministic, reversible test cipher: prefix a 4-byte magic + length
    // then XOR the payload. This lets decryptString detect corruption (the
    // real safeStorage throws on bad ciphertext). NOT secure — test-only.
    const payload = Buffer.from(plain, 'utf8')
    const buf = Buffer.allocUnsafe(4 + payload.length)
    buf.write('RTLT', 0, 'ascii')
    payload.copy(buf, 4)
    for (let i = 4; i < buf.length; i++) buf[i] = buf[i] ^ 0x5a
    return buf
  },
  decryptString(blob) {
    const buf = Buffer.from(blob)
    if (buf.length < 4) throw new Error('safeStorage: invalid ciphertext')
    const copy = Buffer.from(buf)
    for (let i = 4; i < copy.length; i++) copy[i] = copy[i] ^ 0x5a
    if (copy.slice(0, 4).toString('ascii') !== 'RTLT') {
      throw new Error('safeStorage: invalid ciphertext')
    }
    return copy.slice(4).toString('utf8')
  },
}

export function setEncryptionAvailable(available) {
  safeStorage._available = available
}

// The vault only touches safeStorage; expose app/clipboard/ipcMain stubs so
// other modules under test (e.g. ai-ipc) can resolve `electron` too. ipcMain
// captures registered handlers so tests can invoke them directly with a
// trusted event.
export const app = {
  getPath: () => '/tmp/raintool-test',
}
export const clipboard = { readText: () => '', writeText: () => {} }

// ---------------------------------------------------------------------------
// ipcMain handler registry with isolated scopes.
//
// node:test runs test files concurrently in the same process. Two suites
// (ai-context-runtime-ipc, ai-capability-enforcement) both call registerAiIpc,
// which registers handlers on the shared `electron.ipcMain`. A single global
// handler map races under concurrency: one suite's registerAiIpc can overwrite
// or clear another's mid-test, and an invoke in suite A can resolve to suite
// B's fixture (pointing at a temp dir B has already cleaned up → ENOENT).
//
// Fix: each test fixture creates a SCOPE — a fresh handler map — via
// createIpcScope(). The scope exposes the same handle/removeHandler surface
// that registerAiIpc expects (it imports `electron` once and calls
// electron.ipcMain.handle). We make `ipcMain.handle` route to the ACTIVE scope
// (top of the scope stack), so registerAiIpc works unchanged. Each fixture
// invokes against its own scope, so two concurrent suites never share state.
// ---------------------------------------------------------------------------

const scopes = []
// The active scope's handler map; null when no scope is pushed.
let activeHandlers = null

export const ipcMain = {
  handle(channel, fn) {
    if (!activeHandlers) {
      throw new Error(
        'ipcMain.handle called outside an ipc scope; wrap registerAiIpc in createIpcScope().activate()',
      )
    }
    activeHandlers.set(channel, fn)
  },
  removeHandler(channel) {
    if (activeHandlers) activeHandlers.delete(channel)
  },
}

/**
 * Create an isolated IPC handler scope. A fixture calls scope.activate()
 * before registerAiIpc and uses scope._invoke / scope._channels thereafter.
 * Scopes are stackable: activate() pushes, deactivate() pops, so nested
 * fixtures are safe. Two concurrent test suites each get their own scope and
 * never touch each other's handlers.
 */
export function createIpcScope() {
  const handlers = new Map()
  return {
    /** Push this scope's handler map as the active target for ipcMain.handle. */
    activate() {
      scopes.push(activeHandlers)
      activeHandlers = handlers
      return this
    },
    /** Restore the previous active scope (or null at the bottom of the stack). */
    deactivate() {
      activeHandlers = scopes.pop() ?? null
    },
    /** Test-only: invoke a registered handler in THIS scope. */
    _invoke(channel, event, ...args) {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`no handler registered for ${channel}`)
      return fn(event, ...args)
    },
    /** Test-only: list registered channels in THIS scope. */
    _channels() {
      return [...handlers.keys()]
    },
    /** Test-only: clear all handlers in THIS scope (for explicit teardown). */
    _clear() {
      handlers.clear()
    },
  }
}
