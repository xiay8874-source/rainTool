#!/usr/bin/env node

// Unified dev launcher: Vite (renderer) + Next dev (AI Draw.io, under Electron's
// arm64 Node) + Electron main. Ctrl-C tears every child down and confirms the
// 5173/6002 ports are released so a re-run never collides with an orphan.

import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor', 'next-ai-draw-io')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const children = new Set()
const processGroups = new Set()
const temporaryDirectories = new Set()
let shuttingDown = false
let exitCode = 0

function createElectronNodeShim() {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'raintool-dev-node-'))
  temporaryDirectories.add(shimDir)
  const shim = path.join(shimDir, 'node')
  writeFileSync(
    shim,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${JSON.stringify(electronBin)} "$@"\n`,
  )
  chmodSync(shim, 0o755)
  return shimDir
}

function launch(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...options,
  })
  children.add(child)
  if (child.pid) processGroups.add(child.pid)
  child.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev] ${command} exited unexpectedly with code ${code}`)
      shutdown(code ?? 1)
    }
    children.delete(child)
  })
  return child
}

function signalProcessGroup(pid, signal) {
  try {
    if (process.platform === 'win32') {
      const child = [...children].find((candidate) => candidate.pid === pid)
      child?.kill(signal)
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    // The process or group has already exited.
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  exitCode = code
  const groups = [...processGroups]
  for (const pid of groups) signalProcessGroup(pid, 'SIGTERM')

  // npm/Vite can create grandchildren. Each launched service owns a process
  // group, so a final group SIGKILL cannot leave an orphan on 5173/6002.
  setTimeout(async () => {
    for (const pid of groups) signalProcessGroup(pid, 'SIGKILL')
    try {
      await Promise.all([waitForPortFree(5173), waitForPortFree(6002)])
      for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true })
      }
      process.exit(exitCode)
    } catch (error) {
      console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }, 2_000)
}

function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      const request = http.get(url, (response) => {
        response.resume()
        if (response.statusCode && response.statusCode < 500) resolve()
        else retry()
      })
      request.setTimeout(1_000, () => request.destroy())
      request.on('error', retry)
    }
    const retry = () => {
      if (Date.now() >= deadline) reject(new Error(`timed out waiting for ${url}`))
      else setTimeout(poll, 250)
    }
    poll()
  })
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(300)
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(true) })
  })
}

function waitForPortFree(port, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await isPortFree(port)) return resolve()
      if (Date.now() >= deadline) {
        return reject(new Error(`port ${port} is still in use after process-group shutdown`))
      }
      setTimeout(poll, 200)
    }
    poll()
  })
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(0))
}

try {
  if (!existsSync(electronBin)) throw new Error(`Electron binary not found at ${electronBin}; run npm install`)
  if (!existsSync(viteCli)) throw new Error(`Vite CLI not found at ${viteCli}; run npm install`)
  const arm64NodeShimDir = createElectronNodeShim()

  // Prepare drawio assets (idempotent; cached archive is SHA-256 verified).
  const prepared = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-next-standalone.mjs'), '--prepare-drawio-only'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (prepared.status !== 0) throw new Error('failed to prepare local draw.io assets')
  const vendorDependenciesAreArm64 =
    existsSync(path.join(vendor, 'node_modules', 'next')) &&
    existsSync(path.join(vendor, 'node_modules', '@next', 'swc-darwin-arm64')) &&
    !existsSync(path.join(vendor, 'node_modules', '@next', 'swc-darwin-x64'))
  if (!vendorDependenciesAreArm64) {
    // Install under Electron's arm64 Node with a `node` shim on PATH so
    // postinstall scripts also see arm64. Mirrors build-next-standalone.mjs.
    const npmExecpath = process.env.npm_execpath
    if (!npmExecpath || !existsSync(npmExecpath)) throw new Error('npm_execpath not set; run dev via npm run dev')
    const installed = spawnSync(electronBin, [npmExecpath, 'ci', '--cpu', 'arm64', '--os', 'darwin', '--ignore-scripts'], {
      cwd: vendor,
      stdio: 'inherit',
      env: {
        ...process.env,
        PATH: `${arm64NodeShimDir}:${process.env.PATH}`,
        ELECTRON_RUN_AS_NODE: '1',
        NODE: electronBin,
        npm_node_execpath: electronBin,
        HUSKY: '0',
      },
    })
    if (installed.status !== 0) throw new Error('failed to install vendored AI Draw.io dependencies')
  }

  // Vite serves the RainTool renderer on 5173.
  launch(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', '5173'], { cwd: root })

  // Next dev runs under Electron's bundled arm64 Node (ELECTRON_RUN_AS_NODE=1)
  // so the dev server matches the packaged runtime arch. No GUI is opened by
  // this process; the Electron main window is launched separately below.
  const nextCli = path.join(vendor, 'node_modules', 'next', 'dist', 'bin', 'next')
  launch(electronBin, [
    nextCli,
    'dev',
    '--turbopack',
    '--hostname',
    '127.0.0.1',
    '--port',
    '6002',
  ], {
    cwd: vendor,
    env: {
      ...process.env,
      PATH: `${arm64NodeShimDir}:${process.env.PATH}`,
      ELECTRON_RUN_AS_NODE: '1',
      NODE: electronBin,
      npm_node_execpath: electronBin,
      NEXT_PUBLIC_RAINTOOL_EMBEDDED: 'true',
      NEXT_PUBLIC_DRAWIO_BASE_URL: 'http://127.0.0.1:6002/drawio/index.html',
    },
  })

  await Promise.all([
    waitFor('http://127.0.0.1:5173'),
    waitFor('http://127.0.0.1:6002/zh'),
    waitFor('http://127.0.0.1:6002/drawio/index.html'),
  ])

  const compile = spawnSync('npm', ['run', 'build:electron'], { cwd: root, stdio: 'inherit' })
  if (compile.status !== 0) throw new Error('Electron compilation failed')
  launch(electronBin, ['.'], {
    cwd: root,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
      RAINTOOL_AI_DRAWIO_DEV: '1',
    },
  })
} catch (error) {
  console.error(error)
  shutdown(1)
}
