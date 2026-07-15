import { app, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import type { AiDrawioStartResult } from './ai-drawio-types.js'

export const AI_DRAWIO_PRODUCTION_PORT = 13370
export const AI_DRAWIO_DEVELOPMENT_PORT = 6002
const HOST = '127.0.0.1'
const START_TIMEOUT_MS = 30_000

let child: UtilityProcess | null = null
let startPromise: Promise<AiDrawioStartResult> | null = null
let stopPromise: Promise<void> | null = null
let shutdownRequested = false
const recentLogs: string[] = []

function rememberLog(stream: 'stdout' | 'stderr', chunk: unknown): void {
  const text = String(chunk).trim()
  if (!text) return
  const line = `[AI Draw.io ${stream}] ${text}`
  recentLogs.push(line)
  if (recentLogs.length > 80) recentLogs.splice(0, recentLogs.length - 80)
  if (stream === 'stderr') console.error(line)
  else console.info(line)
}

function details(): string | undefined {
  return recentLogs.length ? recentLogs.slice(-20).join('\n') : undefined
}

function publicUrl(port: number): string {
  return `http://${HOST}:${port}/zh`
}

function probeHttpPath(port: number, requestPath: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: HOST, port, path: requestPath, timeout: timeoutMs },
      (response) => {
        response.resume()
        resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400))
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

async function probeHttp(port: number): Promise<boolean> {
  const [appPage, drawioPage] = await Promise.all([
    probeHttpPath(port, '/zh'),
    probeHttpPath(port, '/drawio/index.html'),
  ])
  return appPage && drawioPage
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port })
    const finish = (listening: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitUntilReady(
  port: number,
  didExit?: () => boolean,
): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (didExit?.()) return 'exited'
    if (await probeHttp(port)) return 'ready'
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return 'timeout'
}

async function startDevelopmentServer(): Promise<AiDrawioStartResult> {
  const outcome = await waitUntilReady(AI_DRAWIO_DEVELOPMENT_PORT)
  if (outcome === 'ready') {
    return { status: 'ready', code: 'READY', url: publicUrl(AI_DRAWIO_DEVELOPMENT_PORT) }
  }
  return {
    status: 'error',
    code: 'START_TIMEOUT',
    message: 'AI Draw.io 开发服务未在 30 秒内就绪。请使用 npm run dev 启动完整开发环境。',
  }
}

async function startProductionServer(): Promise<AiDrawioStartResult> {
  if (child?.pid && (await probeHttp(AI_DRAWIO_PRODUCTION_PORT))) {
    return { status: 'ready', code: 'READY', url: publicUrl(AI_DRAWIO_PRODUCTION_PORT) }
  }

  const standaloneDir = app.isPackaged
    ? path.join(process.resourcesPath, 'next-standalone')
    : path.join(app.getAppPath(), 'build', 'next-standalone')
  const serverEntry = path.join(standaloneDir, 'server.js')
  if (!existsSync(serverEntry)) {
    return {
      status: 'error',
      code: 'MISSING_RESOURCE',
      message: 'AI Draw.io 服务资源缺失，请重新安装 RainTool。',
      details: serverEntry,
    }
  }

  if (await isPortListening(AI_DRAWIO_PRODUCTION_PORT)) {
    return {
      status: 'error',
      code: 'PORT_IN_USE',
      message: `端口 ${AI_DRAWIO_PRODUCTION_PORT} 已被其他进程占用。关闭占用程序后重试。`,
    }
  }

  recentLogs.length = 0
  let exited = false
  try {
    if (shutdownRequested) {
      return { status: 'error', code: 'START_FAILED', message: 'RainTool 正在退出，无法启动 AI Draw.io。' }
    }
    const spawned = utilityProcess.fork(serverEntry, [], {
      cwd: standaloneDir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOSTNAME: HOST,
        PORT: String(AI_DRAWIO_PRODUCTION_PORT),
      },
      serviceName: 'RainTool AI Draw.io',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = spawned
    if (shutdownRequested) {
      spawned.kill()
      child = null
      return { status: 'error', code: 'START_FAILED', message: 'RainTool 正在退出，无法启动 AI Draw.io。' }
    }
    spawned.stdout?.on('data', (chunk) => rememberLog('stdout', chunk))
    spawned.stderr?.on('data', (chunk) => rememberLog('stderr', chunk))
    spawned.on('exit', (code) => {
      exited = true
      rememberLog('stderr', `服务进程退出，code=${code}`)
      if (child === spawned) child = null
    })
    spawned.on('error', (type, location) => {
      rememberLog('stderr', `${type}: ${location}`)
    })

    const outcome = await waitUntilReady(AI_DRAWIO_PRODUCTION_PORT, () => exited)
    if (outcome === 'ready') {
      return { status: 'ready', code: 'READY', url: publicUrl(AI_DRAWIO_PRODUCTION_PORT) }
    }

    if (!exited) spawned.kill()
    child = null
    const logDetails = details()
    if (logDetails?.includes('EADDRINUSE')) {
      return {
        status: 'error',
        code: 'PORT_IN_USE',
        message: `端口 ${AI_DRAWIO_PRODUCTION_PORT} 已被其他进程占用。关闭占用程序后重试。`,
        details: logDetails,
      }
    }
    if (outcome === 'timeout') {
      return {
        status: 'error',
        code: 'START_TIMEOUT',
        message: 'AI Draw.io 服务未在 30 秒内就绪，请重试。',
        details: logDetails,
      }
    }
    return {
      status: 'error',
      code: 'START_FAILED',
      message: 'AI Draw.io 服务启动失败，请查看日志后重试。',
      details: logDetails,
    }
  } catch (error) {
    child?.kill()
    child = null
    return {
      status: 'error',
      code: 'START_FAILED',
      message: 'AI Draw.io 服务启动失败，请重试。',
      details: `${error instanceof Error ? error.message : String(error)}${details() ? `\n${details()}` : ''}`,
    }
  }
}

export function startAiDrawioServer(): Promise<AiDrawioStartResult> {
  if (shutdownRequested) {
    return Promise.resolve({
      status: 'error',
      code: 'START_FAILED',
      message: 'RainTool 正在退出，无法启动 AI Draw.io。',
    })
  }
  if (startPromise) return startPromise
  const useExternalDevelopmentServer =
    !app.isPackaged && process.env.RAINTOOL_AI_DRAWIO_DEV === '1'
  startPromise = (useExternalDevelopmentServer
    ? startDevelopmentServer()
    : startProductionServer()).finally(() => {
    startPromise = null
  })
  return startPromise
}

export function stopAiDrawioServer(): Promise<void> {
  shutdownRequested = true
  if (stopPromise) return stopPromise
  const running = child
  if (!running) return Promise.resolve()

  stopPromise = new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (child === running) child = null
      stopPromise = null
      resolve()
    }
    const timer = setTimeout(finish, 3_000)
    running.once('exit', () => {
      clearTimeout(timer)
      finish()
    })
    if (!running.kill()) {
      clearTimeout(timer)
      finish()
    }
  })
  return stopPromise
}

/** Synchronous best-effort fallback for `will-quit`; normal shutdown awaits stopAiDrawioServer. */
export function killAiDrawioServerNow(): void {
  shutdownRequested = true
  child?.kill()
  child = null
}
