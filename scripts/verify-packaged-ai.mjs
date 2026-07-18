#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const appBundle = path.join(root, 'release', 'mac-arm64', `${packageJson.productName}.app`)
const resources = path.join(appBundle, 'Contents', 'Resources')
const standalone = path.join(resources, 'next-standalone')
const dmg = path.join(root, 'release', `${packageJson.productName}-${packageJson.version}-arm64.dmg`)

for (const target of [
  appBundle,
  dmg,
  path.join(resources, 'licenses', 'next-ai-draw-io-APACHE-2.0.txt'),
  path.join(resources, 'licenses', 'drawio-APACHE-2.0.txt'),
  path.join(resources, 'THIRD_PARTY_NOTICES.md'),
  path.join(resources, 'raintool-mcp', 'index.cjs'),
  path.join(resources, 'raintool-mcp', 'raintool-mcp'),
  path.join(resources, 'raintool-mcp', 'THIRD_PARTY_LICENSES.txt'),
]) {
  if (!existsSync(target)) throw new Error(`packaged AI Draw.io resource missing: ${target}`)
}

// Guard: the Electron main process (ESM, `dist-electron/main.js`) keeps bare
// imports for the AI runtime deps (`@ai-sdk/openai`, `ai`,
// `@modelcontextprotocol/sdk`, `zod`). electron-builder ships the production
// dependency subtree inside app.asar; if a dep is dropped from `dependencies`
// or pruned, the packaged main process would crash on first launch with
// ERR_MODULE_NOT_FOUND. Assert each dep root's package.json is present in the
// asar so this gap cannot silently regress (the previous verify only checked
// file existence + the MCP launcher, never main-process dep resolution).
const appAsar = path.join(resources, 'app.asar')
if (!existsSync(appAsar)) throw new Error(`packaged app.asar missing: ${appAsar}`)
const asarEntries = listPackage(appAsar)
const requiredRuntimeDeps = ['@ai-sdk/openai', '@modelcontextprotocol/sdk', 'ai', 'zod']
for (const dep of requiredRuntimeDeps) {
  const entry = `/node_modules/${dep}/package.json`
  if (!asarEntries.includes(entry)) {
    throw new Error(`packaged main-process runtime dep missing from app.asar: ${entry} (add "${dep}" to package.json dependencies)`)
  }
}

const verify = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'verify-next-standalone.mjs'), standalone],
  { cwd: root, stdio: 'inherit' },
)
if (verify.error) throw verify.error
if (verify.status !== 0) throw new Error(`packaged standalone verification failed with ${verify.status}`)

const executable = path.join(appBundle, 'Contents', 'MacOS', packageJson.productName)
const inspected = spawnSync('/usr/bin/file', ['-b', executable], { encoding: 'utf8' })
if (inspected.error || inspected.status !== 0) throw inspected.error ?? new Error(inspected.stderr)
if (!inspected.stdout.includes('Mach-O') || !inspected.stdout.includes('arm64')) {
  throw new Error(`packaged Electron executable is not arm64: ${inspected.stdout.trim()}`)
}

const mcpLauncher = path.join(resources, 'raintool-mcp', 'raintool-mcp')
if ((statSync(mcpLauncher).mode & 0o111) === 0) {
  throw new Error(`packaged RainTool MCP launcher is not executable: ${mcpLauncher}`)
}
const verifyMcp = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'verify-raintool-mcp.mjs'), path.join(resources, 'raintool-mcp')],
  { cwd: root, stdio: 'inherit' },
)
if (verifyMcp.error) throw verifyMcp.error
if (verifyMcp.status !== 0) throw new Error(`packaged MCP verification failed with ${verifyMcp.status}`)

console.log(`[AI Draw.io package verify] ${appBundle} and ${dmg} are complete and arm64-compatible`)
