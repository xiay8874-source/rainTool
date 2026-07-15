#!/usr/bin/env node

// Builds the embedded AI Draw.io (next-ai-draw-io) as a Next.js standalone
// server, pinned to the arm64 macOS target that RainTool ships.
//
// Two details matter for correctness:
//
// 1. `npm ci` runs with `--cpu=arm64 --os=darwin` so optional native deps
//    (e.g. @img/sharp-darwin-arm64) are installed for the shipping arch even
//    when the build host Node is x86_64 (Rosetta). Installing the host arch
//    would put an x64 .node/.dylib into the DMG that cannot load under
//    Electron's bundled arm64 Node.
//
// 2. `next build` runs under Electron's bundled arm64 Node
//    (`ELECTRON_RUN_AS_NODE=1 electron <next-cli>`), never the system Node and
//    never bare `electron` without ELECTRON_RUN_AS_NODE (which would launch the
//    GUI). The standalone output is then bit-for-bit the runtime that will fork
//    `server.js` when the user first opens the AI drawing tab.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'next-ai-draw-io')
const CACHE = path.join(ROOT, '.cache', 'ai-drawio')
const OUTPUT = path.join(ROOT, 'build', 'next-standalone')

const UPSTREAM_VERSION = '0.4.16'
const UPSTREAM_COMMIT = '1115b2d2cdc30ffb7f7b83e1328d3ea00f8de887'
const DRAWIO_VERSION = '29.0.3'
const DRAWIO_COMMIT = 'e159fbf1b1446a37dd68e952ac3db7519735e4f4'
const DRAWIO_ARCHIVE_SHA256 = 'e6d39c6957a575fafd47c67d69fa550517afca4de0f96e530a18b173b9f41d77'
const DRAWIO_ARCHIVE_URL = `https://codeload.github.com/jgraph/drawio/tar.gz/${DRAWIO_COMMIT}`

// RainTool ships an arm64 macOS Electron; its bundled Node is arm64. All vendor
// native deps and the Next build must target this arch.
const TARGET_CPU = 'arm64'
const TARGET_OS = 'darwin'

function fail(message) {
  throw new Error(`[AI Draw.io build] ${message}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function download(url, destination, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('too many redirects'))
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'RainTool-build' } }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume()
        download(new URL(response.headers.location, url).toString(), destination, redirects + 1).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`download failed: HTTP ${response.statusCode}`))
        return
      }
      const stream = createWriteStream(destination)
      response.pipe(stream)
      stream.on('finish', () => stream.close(resolve))
      stream.on('error', reject)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('download timeout')))
    request.on('error', reject)
  })
}

function validateVendor() {
  const packageJson = JSON.parse(readFileSync(path.join(VENDOR, 'package.json'), 'utf8'))
  if (packageJson.version !== UPSTREAM_VERSION) {
    fail(`vendor version is ${packageJson.version}; expected ${UPSTREAM_VERSION}`)
  }
  const versionFile = readFileSync(path.join(VENDOR, 'UPSTREAM_VERSION'), 'utf8')
  for (const expected of [
    `version=v${UPSTREAM_VERSION}`,
    `commit=${UPSTREAM_COMMIT}`,
    `drawio_version=v${DRAWIO_VERSION}`,
    `drawio_commit=${DRAWIO_COMMIT}`,
  ]) {
    if (!versionFile.includes(expected)) fail(`UPSTREAM_VERSION is missing ${expected}`)
  }
}

async function prepareDrawio() {
  mkdirSync(CACHE, { recursive: true })
  const archive = path.join(CACHE, `drawio-${DRAWIO_COMMIT}.tar.gz`)
  if (existsSync(archive) && sha256(archive) !== DRAWIO_ARCHIVE_SHA256) {
    console.warn('[AI Draw.io build] cached archive checksum mismatch; downloading again')
    rmSync(archive)
  }
  if (!existsSync(archive)) {
    const partial = `${archive}.partial`
    rmSync(partial, { force: true })
    console.log(`[AI Draw.io build] downloading draw.io ${DRAWIO_VERSION} (${DRAWIO_COMMIT})`)
    await download(DRAWIO_ARCHIVE_URL, partial)
    if (sha256(partial) !== DRAWIO_ARCHIVE_SHA256) {
      rmSync(partial, { force: true })
      fail('downloaded draw.io archive checksum mismatch')
    }
    copyFileSync(partial, archive)
    rmSync(partial)
  }
  if (sha256(archive) !== DRAWIO_ARCHIVE_SHA256) fail('cached draw.io archive checksum mismatch')

  const extracted = path.join(CACHE, `drawio-${DRAWIO_COMMIT}`)
  rmSync(extracted, { recursive: true, force: true })
  mkdirSync(extracted, { recursive: true })
  run('tar', ['-xzf', archive, '-C', extracted, '--strip-components=1'])
  const actualVersion = readFileSync(path.join(extracted, 'VERSION'), 'utf8').trim()
  if (actualVersion !== DRAWIO_VERSION) fail(`draw.io VERSION is ${actualVersion}; expected ${DRAWIO_VERSION}`)

  const webapp = path.join(extracted, 'src', 'main', 'webapp')
  const target = path.join(VENDOR, 'public', 'drawio')
  rmSync(target, { recursive: true, force: true })
  cpSync(webapp, target, {
    recursive: true,
    filter: (source) => !['WEB-INF', 'META-INF'].includes(path.basename(source)),
  })
  copyFileSync(path.join(extracted, 'LICENSE'), path.join(target, 'LICENSE'))
  console.log(`[AI Draw.io build] prepared local draw.io at ${target}`)
}

// Resolve the Electron binary bundled in the root devDependencies. We run it
// with ELECTRON_RUN_AS_NODE=1 so it behaves as a pure Node runtime (arm64) and
// never opens a window.
function electronBinary() {
  const candidate = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  if (!existsSync(candidate)) fail(`Electron binary not found at ${candidate}; run npm install in the project root`)
  const inspected = spawnSync('/usr/bin/file', ['-b', candidate], { encoding: 'utf8' })
  if (inspected.status !== 0 || !inspected.stdout.includes('arm64')) {
    fail(
      `Electron must contain an arm64 slice for the shipping runtime; found ${inspected.stdout.trim() || 'unknown architecture'}`,
    )
  }
  return candidate
}

// Resolve the npm CLI entry point. When this script is invoked via
// `npm run build:ai`, npm sets npm_execpath to its own CLI script; otherwise we
// fall back to the resolved npm executable. This intentionally avoids a fixed
// Homebrew, nvm, or system npm installation path.
function npmCliPath() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath
  }
  const which = spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout.trim()
  if (!which) fail('could not locate npm; run via npm run build:ai or ensure npm is on PATH')
  return realpathSync(which)
}

// Build an environment where `node` on PATH resolves to Electron's bundled
// arm64 Node. npm spawns postinstall lifecycle scripts with the `node` found on
// PATH (not process.execPath), so without this shim those scripts run under the
// system x64 Node and select/install x64 native binaries. We also export
// ELECTRON_RUN_AS_NODE=1 so Electron behaves as a pure Node runtime.
function arm64NodeEnv(electron) {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'raintool-arm64-node-'))
  const shim = path.join(shimDir, 'node')
  writeFileSync(
    shim,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${JSON.stringify(electron)} "$@"\n`,
  )
  chmodSync(shim, 0o755)
  return {
    shimDir,
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      ELECTRON_RUN_AS_NODE: '1',
      NODE: electron,
      npm_node_execpath: electron,
      HUSKY: '0',
    },
  }
}

// Same behavior as the upstream Electron packager: bundle real contents instead
// of symlinks so macOS signing and electron-builder cannot reference files outside.
function copyDereferenced(source, destination) {
  const info = lstatSync(source)
  if (info.isSymbolicLink()) {
    const target = statSync(source)
    if (target.isDirectory()) {
      mkdirSync(destination, { recursive: true })
      for (const entry of readdirSync(source)) {
        copyDereferenced(path.join(source, entry), path.join(destination, entry))
      }
    } else {
      mkdirSync(path.dirname(destination), { recursive: true })
      copyFileSync(source, destination)
    }
    return
  }
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source)) {
      copyDereferenced(path.join(source, entry), path.join(destination, entry))
    }
    return
  }
  mkdirSync(path.dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}

async function main() {
  validateVendor()
  await prepareDrawio()
  if (process.argv.includes('--prepare-drawio-only')) return

  // Install vendor deps for the shipping arch, run under Electron's arm64 Node
  // so postinstall scripts that detect process.arch also target arm64.
  // --cpu/--os force optional native packages to arm64 regardless of the build
  // host's Node arch. --ignore-scripts avoids vendored desktop-development
  // installers (notably Electron) that are irrelevant to the Next application
  // and cannot safely extract a second Electron bundle while npm itself runs
  // under Electron Node. The required prebuilt native modules are verified by
  // loading them below, by next build, and by binary inspection after tracing.
  const electron = electronBinary()
  const { shimDir, env: arm64Env } = arm64NodeEnv(electron)
  try {
    console.log(`[AI Draw.io build] installing vendored dependencies for ${TARGET_CPU}/${TARGET_OS} under Electron arm64 Node`)
    run(electron, [npmCliPath(), 'ci', '--cpu', TARGET_CPU, '--os', TARGET_OS, '--ignore-scripts'], {
      cwd: VENDOR,
      env: arm64Env,
    })

    const moduleSmoke = [
      "for (const name of ['sharp', 'lightningcss']) {",
      "  require(name)",
      "  console.log('[AI Draw.io build] loaded ' + name + ' under ' + process.arch)",
      '}',
    ].join('\n')
    run(electron, ['-e', moduleSmoke], { cwd: VENDOR, env: arm64Env })

    // Build under Electron's bundled arm64 Node so the standalone output matches
    // the runtime that will fork server.js. We invoke the Next CLI directly with
    // ELECTRON_RUN_AS_NODE=1; no GUI is opened.
    const nextCli = path.join(VENDOR, 'node_modules', 'next', 'dist', 'bin', 'next')
    if (!existsSync(nextCli)) fail(`next CLI not found at ${nextCli}`)
    console.log('[AI Draw.io build] building embedded Next.js standalone under Electron arm64 Node')
    run(electron, [nextCli, 'build'], {
      cwd: VENDOR,
      env: {
        ...arm64Env,
        NEXT_PUBLIC_RAINTOOL_EMBEDDED: 'true',
        NEXT_PUBLIC_DRAWIO_BASE_URL: 'http://127.0.0.1:13370/drawio/index.html',
      },
    })
  } finally {
    rmSync(shimDir, { recursive: true, force: true })
  }

  const standalone = path.join(VENDOR, '.next', 'standalone')
  const serverEntry = path.join(standalone, 'server.js')
  if (!existsSync(serverEntry)) fail(`standalone server is missing: ${serverEntry}`)
  rmSync(OUTPUT, { recursive: true, force: true })
  mkdirSync(OUTPUT, { recursive: true })
  copyDereferenced(standalone, OUTPUT)
  copyDereferenced(path.join(VENDOR, '.next', 'static'), path.join(OUTPUT, '.next', 'static'))
  copyDereferenced(path.join(VENDOR, 'public'), path.join(OUTPUT, 'public'))
  // Next build caches are host-specific and a signed app bundle must stay
  // immutable at runtime. isrFlushToDisk=false keeps production caches in
  // memory; remove the build cache and make its presence a verification error.
  rmSync(path.join(OUTPUT, '.next', 'cache'), { recursive: true, force: true })
  run(process.execPath, [path.join(ROOT, 'scripts', 'verify-next-standalone.mjs')], { cwd: ROOT })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
