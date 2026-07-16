#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MCP_ROOT = path.join(ROOT, 'vendor', 'next-ai-draw-io', 'packages', 'mcp-server')
const OUTPUT = path.join(ROOT, 'build', 'raintool-mcp')
const ESBUILD = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')
const META = path.join(OUTPUT, 'bundle-meta.json')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`)
}

run('npm', ['ci', '--ignore-scripts'], { cwd: MCP_ROOT })
rmSync(OUTPUT, { recursive: true, force: true })
mkdirSync(OUTPUT, { recursive: true })
run(ESBUILD, [
  path.join(MCP_ROOT, 'src', 'raintool-index.ts'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  `--outfile=${path.join(OUTPUT, 'index.cjs')}`,
  `--metafile=${META}`,
  '--legal-comments=none',
  '--log-level=warning',
])
copyFileSync(path.join(ROOT, 'scripts', 'raintool-mcp-launcher.sh'), path.join(OUTPUT, 'raintool-mcp'))
copyFileSync(path.join(MCP_ROOT, 'README.md'), path.join(OUTPUT, 'UPSTREAM_MCP_README.md'))
chmodSync(path.join(OUTPUT, 'raintool-mcp'), 0o755)

// Preserve the licenses of exactly the packages that esbuild placed in the
// distributable single-file MCP server. This is derived from the metafile, so
// unused upstream dependencies are not incorrectly reported as shipped.
const metafile = JSON.parse(readFileSync(META, 'utf8'))
const packageRoots = new Set()
for (const input of Object.keys(metafile.inputs)) {
  const marker = `${path.sep}node_modules${path.sep}`
  const absolute = path.resolve(ROOT, input)
  const index = absolute.lastIndexOf(marker)
  if (index < 0) continue
  const base = absolute.slice(0, index + marker.length)
  const rest = absolute.slice(index + marker.length).split(path.sep)
  const packageName = rest[0]?.startsWith('@') ? rest.slice(0, 2).join(path.sep) : rest[0]
  if (packageName) packageRoots.add(path.join(base, packageName))
}

const licenseSections = []
for (const packageRoot of [...packageRoots].sort()) {
  const manifestPath = path.join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']
    .map((name) => path.join(packageRoot, name))
    .find(existsSync)
  const body = licenseFile
    ? readFileSync(licenseFile, 'utf8').trim()
    : `License declared by package: ${manifest.license || 'UNKNOWN'}`
  licenseSections.push(`${manifest.name}@${manifest.version}\n${'-'.repeat(72)}\n${body}`)
}
writeFileSync(
  path.join(OUTPUT, 'THIRD_PARTY_LICENSES.txt'),
  `RainTool MCP bundled dependency licenses\n\n${licenseSections.join('\n\n')}\n`,
)
rmSync(META, { force: true })

console.log(`[RainTool MCP build] ${OUTPUT}`)
