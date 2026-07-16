import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  RAINTOOL_DIAGRAM_PROTOCOL_VERSION,
  type DiagramBridgeRpcRequest,
  type DiagramBridgeRpcResponse,
  type DiagramCreateInput,
  type DiagramDuplicateInput,
  type DiagramListQuery,
  type DiagramUpdateInput,
  type LegacyDiagramInput,
} from './diagram-types.js'
import {
  DiagramConflictError,
  DiagramNotFoundError,
  DiagramRepository,
} from './diagram-repository.js'

export const DIAGRAM_BRIDGE_HOST = '127.0.0.1'
export const DIAGRAM_BRIDGE_PORT = 13371
const MAX_REQUEST_BYTES = 14 * 1024 * 1024

interface AuthFile {
  version: number
  host: string
  port: number
  token: string
}

interface DiagramBridgeServerOptions {
  dataDir: string
  repository: DiagramRepository
  /** Production omits this and stays on 13371; tests may use port 0. */
  port?: number
  getActiveDiagramId: () => string | null
  openDiagram: (id: string) => void
  exportDiagram: (id: string, format: 'png' | 'svg') => Promise<string>
  onChanged: (document: ReturnType<DiagramRepository['require']>, reason: 'created' | 'updated' | 'duplicated' | 'restored' | 'migrated') => void
  onDeleted: (id: string) => void
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function stringParam(params: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = params[key]
  if (typeof value === 'string' && value.trim()) return value
  if (required) throw new Error(`缺少字符串参数：${key}`)
  return undefined
}

export class DiagramBridgeServer {
  private readonly options: DiagramBridgeServerOptions
  private readonly authPath: string
  private readonly token: string
  private readonly configuredPort: number
  private server: http.Server | null = null

  constructor(options: DiagramBridgeServerOptions) {
    this.options = options
    this.authPath = path.join(options.dataDir, 'mcp-auth.json')
    this.configuredPort = options.port ?? DIAGRAM_BRIDGE_PORT
    this.token = this.loadOrCreateToken()
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handleRequest(req, res))
      server.on('error', reject)
      server.listen(this.configuredPort, DIAGRAM_BRIDGE_HOST, () => {
        server.off('error', reject)
        this.server = server
        const address = server.address()
        const actualPort = typeof address === 'object' && address ? address.port : this.configuredPort
        this.writeAuthFile(this.token, actualPort)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    if (!this.isAuthorized(req)) {
      this.respond(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      this.respond(res, 200, {
        ok: true,
        result: {
          app: 'RainTool',
          protocolVersion: RAINTOOL_DIAGRAM_PROTOCOL_VERSION,
        },
      })
      return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      this.respond(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } })
      return
    }
    try {
      const request = JSON.parse(await this.readBody(req)) as DiagramBridgeRpcRequest
      if (!request || typeof request.method !== 'string') throw new Error('无效的 RPC 请求')
      const result = await this.dispatch(request.method, request.params)
      this.respond(res, 200, { ok: true, result })
    } catch (error) {
      const response = this.errorResponse(error)
      this.respond(res, response.error?.code === 'NOT_FOUND' ? 404 : 400, response)
    }
  }

  private async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    const params = objectParams(rawParams)
    const repository = this.options.repository
    switch (method) {
      case 'system.info':
        return { app: 'RainTool', protocolVersion: RAINTOOL_DIAGRAM_PROTOCOL_VERSION }
      case 'diagram.list':
        return repository.list(params as DiagramListQuery)
      case 'diagram.get':
        return repository.require(stringParam(params, 'id')!)
      case 'diagram.getActive': {
        const id = this.options.getActiveDiagramId()
        return id ? repository.get(id) : null
      }
      case 'diagram.create': {
        const document = repository.create(params as DiagramCreateInput)
        this.options.onChanged(document, 'created')
        return document
      }
      case 'diagram.update': {
        const document = repository.update(params as unknown as DiagramUpdateInput)
        this.options.onChanged(document, 'updated')
        return document
      }
      case 'diagram.duplicate': {
        const document = repository.duplicate(params as unknown as DiagramDuplicateInput)
        this.options.onChanged(document, 'duplicated')
        return document
      }
      case 'diagram.delete': {
        const id = stringParam(params, 'id')!
        const deleted = repository.delete(id)
        if (deleted) this.options.onDeleted(id)
        return { deleted }
      }
      case 'diagram.listRevisions':
        return repository.listRevisions(stringParam(params, 'id')!)
      case 'diagram.restoreRevision': {
        const id = stringParam(params, 'id')!
        const revision = Number(params.revision)
        if (!Number.isInteger(revision) || revision < 1) throw new Error('无效的 revision')
        const expectedRevision = params.expectedRevision === undefined
          ? undefined
          : Number(params.expectedRevision)
        const document = repository.restoreRevision(id, revision, expectedRevision)
        this.options.onChanged(document, 'restored')
        return document
      }
      case 'diagram.migrateLegacy': {
        const items = Array.isArray(params.items) ? params.items as LegacyDiagramInput[] : []
        const result = repository.migrateLegacy(items)
        for (const document of result.documents) this.options.onChanged(document, 'migrated')
        return result
      }
      case 'diagram.open': {
        const id = stringParam(params, 'id')!
        const document = repository.require(id)
        this.options.openDiagram(id)
        return document
      }
      case 'diagram.export': {
        const id = stringParam(params, 'id')!
        repository.require(id)
        const format = stringParam(params, 'format')
        if (format !== 'png' && format !== 'svg') throw new Error('format 仅支持 png 或 svg')
        return { id, format, data: await this.options.exportDiagram(id, format) }
      }
      default:
        throw new Error(`未知 RPC 方法：${method}`)
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_REQUEST_BYTES) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return false
    const actual = Buffer.from(header.slice('Bearer '.length))
    const expected = Buffer.from(this.token)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private loadOrCreateToken(): string {
    try {
      if (existsSync(this.authPath)) {
        const parsed = JSON.parse(readFileSync(this.authPath, 'utf8')) as AuthFile
        if (parsed.version === RAINTOOL_DIAGRAM_PROTOCOL_VERSION && typeof parsed.token === 'string' && parsed.token.length >= 32) {
          chmodSync(this.authPath, 0o600)
          this.writeAuthFile(parsed.token, this.configuredPort)
          return parsed.token
        }
      }
    } catch { /* create a new token below */ }
    const token = randomBytes(32).toString('hex')
    this.writeAuthFile(token, this.configuredPort)
    return token
  }

  private writeAuthFile(token: string, port: number): void {
    const auth: AuthFile = {
      version: RAINTOOL_DIAGRAM_PROTOCOL_VERSION,
      host: DIAGRAM_BRIDGE_HOST,
      port,
      token,
    }
    writeFileSync(this.authPath, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 })
  }

  private errorResponse(error: unknown): DiagramBridgeRpcResponse {
    if (error instanceof DiagramConflictError) {
      return {
        ok: false,
        error: { code: 'REVISION_CONFLICT', message: error.message, data: error.current },
      }
    }
    if (error instanceof DiagramNotFoundError) {
      return { ok: false, error: { code: 'NOT_FOUND', message: error.message } }
    }
    return {
      ok: false,
      error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) },
    }
  }

  private respond(res: http.ServerResponse, status: number, payload: DiagramBridgeRpcResponse): void {
    res.writeHead(status)
    res.end(JSON.stringify(payload))
  }
}
