// ESM resolve/load hook that redirects bare `electron` imports to the test
// stub at tests/fixtures/electron-stub.mjs. Loaded via `module.register()`
// from ai-credential-vault.test.mjs (and any other test needing the vault).
//
// This keeps tests free of monkeypatched globals and lets the compiled vault
// module resolve `electron` exactly as it would at runtime, just with a
// controllable safeStorage.

import { pathToFileURL } from 'node:url'
import { fileURLToPath, pathToFileURL as toUrl } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const stubUrl = toUrl(resolvePath(__dirname, 'electron-stub.mjs')).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: stubUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
