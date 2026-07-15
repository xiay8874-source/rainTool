#!/usr/bin/env node

// Verifies the assembled build/next-standalone is complete and every native
// binary targets arm64 (or is universal). RainTool ships an arm64 macOS
// Electron whose bundled Node forks server.js; a single x64 .node/.dylib would
// crash at load time, so any mismatch is a hard failure, not a warning.

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const standalone = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'build', 'next-standalone')
const required = [
  'server.js',
  'node_modules/next',
  '.next/static',
  'public',
  'public/drawio/index.html',
  'public/drawio/LICENSE',
]

if (!existsSync(standalone)) throw new Error(`standalone directory missing: ${standalone}`)
if (existsSync(path.join(standalone, '.next', 'cache'))) {
  throw new Error('standalone must not contain writable build/runtime cache: .next/cache')
}

for (const relative of required) {
  const target = path.join(standalone, relative)
  if (!existsSync(target)) throw new Error(`standalone resource missing: ${relative}`)
}

function findNativeBinaries(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const info = lstatSync(full)
    if (info.isFile() && /\.(node|dylib|so|dll)$/.test(entry)) found.push(full)
    else if (info.isDirectory()) findNativeBinaries(full, found)
  }
  return found
}

function assertNoSymlinks(directory) {
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry)
    const info = lstatSync(target)
    if (info.isSymbolicLink()) throw new Error(`standalone contains symlink: ${target}`)
    if (info.isDirectory()) assertNoSymlinks(target)
  }
}

assertNoSymlinks(standalone)

const nodeModules = path.join(standalone, 'node_modules')
const mismatches = []
if (existsSync(nodeModules)) {
  for (const binary of findNativeBinaries(nodeModules)) {
    const relative = path.relative(standalone, binary)
    const inspected = spawnSync('/usr/bin/file', ['-b', binary], { encoding: 'utf8' })
    if (inspected.error || inspected.status !== 0) {
      throw new Error(`could not inspect native binary ${relative}: ${inspected.stderr || inspected.error}`)
    }
    const description = inspected.stdout.trim()
    // A universal binary is accepted only when its slices include arm64.
    // Checking the file contents (rather than package names) catches renamed
    // or incorrectly published x64/ELF/PE binaries as well.
    if (!description.includes('Mach-O') || !description.includes('arm64')) {
      mismatches.push(`${relative}: ${description || 'unknown binary format'}`)
    }
  }
}

if (mismatches.length > 0) {
  console.error('[AI Draw.io verify] FAIL: mismatched-arch native binaries present:')
  for (const m of mismatches) console.error(`  ${m}`)
  throw new Error(`standalone contains ${mismatches.length} mismatched-arch native binary(ies); aborting`)
}

console.log(
  `[AI Draw.io verify] ${standalone} is complete, contains no symlinks, and all native binaries include arm64`,
)
