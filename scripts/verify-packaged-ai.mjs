#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
