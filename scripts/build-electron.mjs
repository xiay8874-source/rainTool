#!/usr/bin/env node

import { copyFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRELOAD_OUTPUT = path.join(ROOT, 'dist-electron-preload')

function run(args) {
  const result = spawnSync('npx', ['tsc', ...args], { cwd: ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tsc ${args.join(' ')} failed with ${result.status}`)
}

rmSync(PRELOAD_OUTPUT, { recursive: true, force: true })
rmSync(path.join(ROOT, 'dist-electron', 'preload.js'), { force: true })
run(['-p', 'electron/tsconfig.json'])
run(['-p', 'electron/tsconfig.preload.json'])

const source = path.join(PRELOAD_OUTPUT, 'preload.js')
if (!existsSync(source)) throw new Error(`compiled preload missing: ${source}`)
copyFileSync(source, path.join(ROOT, 'dist-electron', 'preload.cjs'))
rmSync(PRELOAD_OUTPUT, { recursive: true, force: true })
