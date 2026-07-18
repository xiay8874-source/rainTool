// ESM resolve/load hook that redirects bare `electron` to the AI Draw.io
// service test stub AND redirects `node:http` / `node:net` to controllable
// stubs. Loaded via `module.register()` from ai-drawio-service.test.mjs only.
// Other tests use the generic electron-stub (which doesn't expose
// utilityProcess); this stub is tailored to the ai-drawio-service module's
// surface (utilityProcess.fork + app.isPackaged + app.getAppPath +
// process.resourcesPath + HTTP probe + port-listen probe).
//
// Why stub http/net: the service uses `http.get` to probe /zh and
// /drawio/index.html, and `net.createConnection` to check if the port is
// already taken. Without stubs, those would hit real sockets (and the
// PORT_IN_USE test would depend on a real port being free). The stubs read
// from the shared electron-drawio-stub state so tests configure behavior
// via setElectronStub({probeResult, portListening, ...}).

import { fileURLToPath, pathToFileURL as toUrl } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stubUrl = toUrl(resolvePath(__dirname, 'electron-drawio-stub.mjs')).href
const httpStubUrl = toUrl(resolvePath(__dirname, 'http-stub.mjs')).href
const netStubUrl = toUrl(resolvePath(__dirname, 'net-stub.mjs')).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: stubUrl, shortCircuit: true }
  }
  if (specifier === 'node:http') {
    return { url: httpStubUrl, shortCircuit: true }
  }
  if (specifier === 'node:net') {
    return { url: netStubUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
