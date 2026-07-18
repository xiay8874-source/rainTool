// Test-only stub for `node:net`, used by ai-drawio-service.test.mjs.
//
// The service calls `net.createConnection({host, port})` to check if the port
// is already taken. The stub reads `portListening` from the shared
// electron-drawio-stub state: when true, the socket 'connect's immediately
// (port in use → PORT_IN_USE); when false, the socket 'error's (port free →
// proceed to spawn).
//
// The stub mirrors the real net.createConnection contract: returns a socket
// with setTimeout, once('connect'), once('timeout'), once('error'),
// removeAllListeners, destroy.
//
// NEVER shipped — used only by tests/ai-drawio-service.test.mjs.

import { EventEmitter } from 'node:events'

let stateProxy = null
async function getState() {
  if (!stateProxy) {
    const stubUrl = new URL('./electron-drawio-stub.mjs', import.meta.url).href
    const mod = await import(stubUrl)
    stateProxy = mod.__testState
  }
  return stateProxy
}

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
  }
  setTimeout(_ms) { /* no-op */ }
  destroy() {
    if (this.destroyed) return this
    this.destroyed = true
    return this
  }
}

export function createConnection(_options) {
  const socket = new FakeSocket()
  // Defer the connect/error so the service registers listeners first.
  queueMicrotask(async () => {
    const state = await getState()
    if (state.portListening) {
      socket.emit('connect')
    } else {
      socket.emit('error', new Error('connect ECONNREFUSED (stub: port free)'))
    }
  })
  return socket
}

export default { createConnection }
