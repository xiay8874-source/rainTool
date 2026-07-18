import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWriteStream, unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import { spawn } from 'node:child_process'
import {
  killAiDrawioServerNow,
  startAiDrawioServer,
  stopAiDrawioServer,
} from './ai-drawio-service.js'
import { initAiPlatform, getAiPlatform } from './ai-platform/index.js'
import { DiagramBridgeServer } from './diagram-bridge-server.js'
import {
  DiagramConflictError,
  DiagramRepository,
} from './diagram-repository.js'
import type {
  DiagramChangedEvent,
  DiagramCreateInput,
  DiagramDeletedEvent,
  DiagramDuplicateInput,
  DiagramExportRequest,
  DiagramExportResult,
  DiagramListQuery,
  DiagramOpenRequest,
  DiagramUpdateInput,
  LegacyDiagramInput,
} from './diagram-types.js'
import { GitRepositoryService } from './git-repository-service.js'
import type { GitCommitInput, GitCommitProposalRequest, GitPushUpstreamInput } from './git-types.js'
import { GitRunnerError } from './git-runner.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const isDev = !app.isPackaged
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const APP_INDEX_PATH = path.resolve(__dirname, '..', 'dist', 'index.html')

// ============ 持久化:~/raintool/ 明文 JSON 文件 ============
// 用户主目录下,用户可见可备份。替代 electron-store(其异步 IPC 在退出时不可靠)。
// 主进程同步 fs 读写,store:set 为同步写盘,保证退出前数据落盘。
const DATA_DIR = path.join(app.getPath('home'), 'raintool')
try { mkdirSync(DATA_DIR, { recursive: true }) } catch { /* 已存在或无权限,忽略 */ }

function readData(key: string): unknown {
  try {
    return JSON.parse(readFileSync(path.join(DATA_DIR, `${key}.json`), 'utf8'))
  } catch {
    return null
  }
}

function writeData(key: string, value: unknown): void {
  writeFileSync(path.join(DATA_DIR, `${key}.json`), JSON.stringify(value))
}

function deleteData(key: string): void {
  try { unlinkSync(path.join(DATA_DIR, `${key}.json`)) } catch { /* 不存在无妨 */ }
}

let mainWindow: BrowserWindow | null = null
const diagramRepository = new DiagramRepository(DATA_DIR)
let activeDiagramId: string | null = null
let queuedDiagramOpen: DiagramOpenRequest | null = null
let diagramRendererReady = false
const readyDiagramEditors = new Set<string>()
const pendingDiagramExports = new Map<string, {
  request: DiagramExportRequest
  resolve: (data: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  sent: boolean
}>()

function assertTrustedRenderer(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('拒绝来自非 RainTool 主渲染页的请求')
  }
}

/**
 * 把 GitRepositoryService 抛出的 GitError 转成 IPC 可传输的 Error。
 * Electron 把 ipcMain.handle 抛出的 Error 的 .message 透传给渲染进程的
 * ipcRenderer.invoke reject；我们在 message 里编码结构化 code，渲染层用
 * parseGitIpcError 还原。原始 stderr/命令行/token 永不泄露——服务层已脱敏。
 */
function toIpcError(e: unknown): Error {
  const gitErr = e as { code?: string; message?: string } | undefined
  const code = gitErr?.code ?? 'COMMAND_FAILED'
  const message = gitErr?.message ?? 'Git 操作失败'
  const err = new Error(`[git:${code}] ${message}`)
  // 额外挂在 .code 上，方便渲染层直接读取（contextBridge 透传自有属性）。
  ;(err as { code?: string }).code = code
  return err
}

/**
 * System prompt for the AI commit-message proposer (Task 4). Instructs the model
 * to base the proposal ONLY on the provided staged diff context, to reply with
 * strict JSON matching the title-only CommitProposalSchema, and to
 * avoid speculative content. The user prompt (built by the service) carries the
 * staged context; this system prompt is static + secret-free.
 */
const COMMIT_PROPOSAL_SYSTEM_PROMPT = [
  '你是一个 Git 提交标题助手。仅根据用户提供的「已暂存变更」上下文生成一个提交标题。',
  '上下文中的已暂存 patch 就是本任务的完整输入；必须直接生成标题，不要索要更多 diff 或代码。',
  '未暂存或未跟踪的文件不在上下文中，不要臆测它们。',
  '敏感文件（.env/.pem/密钥等）已排除，仅提供文件名与状态——不要在输出中还原其内容。',
  '只输出一行纯文本提交标题，不要输出 JSON、解释、正文或 markdown 代码块。',
  '标题必须使用英文；代码标识符、文件名和 API 名称保持原样。',
  'subject 使用简洁的英文祈使语气，最多 100 个字符，优先使用 Conventional Commit 格式（type(scope): summary）。',
  '即使输入的 diff 或用户界面文案为中文，也不得输出中文提交说明。',
  '不要添加 body、rationale、type、scope、breaking、confidence 或其它字段。',
].join('\n')

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function emitDiagramChanged(
  document: ReturnType<DiagramRepository['require']>,
  reason: DiagramChangedEvent['reason'],
): void {
  const event: DiagramChangedEvent = { document, reason }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diagram:changed', event)
}

function emitDiagramDeleted(id: string): void {
  const event: DiagramDeletedEvent = { id }
  if (activeDiagramId === id) activeDiagramId = null
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diagram:deleted', event)
}

function openDiagramInRenderer(id: string): void {
  diagramRepository.require(id)
  activeDiagramId = id
  const request: DiagramOpenRequest = { id, focus: true }
  queuedDiagramOpen = request
  showMainWindow()
  if (diagramRendererReady && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('diagram:open-requested', request)
    queuedDiagramOpen = null
  }
}

function sendPendingExportsFor(id: string): void {
  if (!readyDiagramEditors.has(id) || !mainWindow || mainWindow.isDestroyed()) return
  for (const pending of pendingDiagramExports.values()) {
    if (pending.request.id !== id || pending.sent) continue
    pending.sent = true
    mainWindow.webContents.send('diagram:export-requested', pending.request)
  }
}

function requestDiagramExport(id: string, format: 'png' | 'svg'): Promise<string> {
  diagramRepository.require(id)
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const request: DiagramExportRequest = { requestId, id, format }
    const timer = setTimeout(() => {
      pendingDiagramExports.delete(requestId)
      reject(new Error(`图纸 ${format.toUpperCase()} 导出超时`))
    }, 20_000)
    pendingDiagramExports.set(requestId, { request, resolve, reject, timer, sent: false })
    openDiagramInRenderer(id)
    sendPendingExportsFor(id)
  })
}

const diagramBridge = new DiagramBridgeServer({
  dataDir: DATA_DIR,
  repository: diagramRepository,
  getActiveDiagramId: () => activeDiagramId,
  openDiagram: openDiagramInRenderer,
  exportDiagram: requestDiagramExport,
  onChanged: emitDiagramChanged,
  onDeleted: emitDiagramDeleted,
})

// ============ Git Workbench (Task 1+2) ============
// 单例 GitRepositoryService：持有 repoId→root 映射、最近仓库、status/diff/stage。
// 所有 IPC handler 都先 assertTrustedRenderer，渲染进程拿不到 cwd/root/命令，
// 只能传 repositoryId（由主进程在 open 时分配）。
const gitRepositoryService = new GitRepositoryService()
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  showMainWindow()
})

// 持久化 IPC:工作区 / 收藏夹 / 配置(同步 fs 读写,渲染层无感)
ipcMain.handle('store:get', (_e, key: string) => readData(key))
ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
  writeData(key, value)
})
ipcMain.handle('store:delete', (_e, key: string) => {
  deleteData(key)
})

// ============ 图纸库 IPC：所有图纸以 diagramId 持久化到 ~/raintool/diagrams ============
ipcMain.handle('diagram:list', (event, query: DiagramListQuery) => {
  assertTrustedRenderer(event)
  return diagramRepository.list(query)
})
ipcMain.handle('diagram:get', (event, id: string) => {
  assertTrustedRenderer(event)
  return diagramRepository.get(id)
})
ipcMain.handle('diagram:create', (event, input: DiagramCreateInput) => {
  assertTrustedRenderer(event)
  const document = diagramRepository.create(input)
  emitDiagramChanged(document, 'created')
  return document
})
ipcMain.handle('diagram:update', (event, input: DiagramUpdateInput) => {
  assertTrustedRenderer(event)
  try {
    const document = diagramRepository.update(input)
    emitDiagramChanged(document, 'updated')
    return { status: 'ok' as const, document }
  } catch (error) {
    if (error instanceof DiagramConflictError) {
      return { status: 'conflict' as const, document: error.current }
    }
    throw error
  }
})
ipcMain.handle('diagram:duplicate', (event, input: DiagramDuplicateInput) => {
  assertTrustedRenderer(event)
  const document = diagramRepository.duplicate(input)
  emitDiagramChanged(document, 'duplicated')
  return document
})
ipcMain.handle('diagram:delete', (event, id: string) => {
  assertTrustedRenderer(event)
  const deleted = diagramRepository.delete(id)
  if (deleted) emitDiagramDeleted(id)
  return deleted
})
ipcMain.handle('diagram:list-revisions', (event, id: string) => {
  assertTrustedRenderer(event)
  return diagramRepository.listRevisions(id)
})
ipcMain.handle('diagram:restore-revision', (event, id: string, revision: number, expectedRevision?: number) => {
  assertTrustedRenderer(event)
  const document = diagramRepository.restoreRevision(id, revision, expectedRevision)
  emitDiagramChanged(document, 'restored')
  return document
})
ipcMain.handle('diagram:migrate-legacy', (event, items: LegacyDiagramInput[]) => {
  assertTrustedRenderer(event)
  const result = diagramRepository.migrateLegacy(items)
  for (const document of result.documents) emitDiagramChanged(document, 'migrated')
  return result
})
ipcMain.handle('diagram:set-active', (event, id: string | null) => {
  assertTrustedRenderer(event)
  if (id) diagramRepository.require(id)
  activeDiagramId = id
})

// ============ Git Workbench IPC（Task 1+2）============
// 安全契约：所有 handler 先 assertTrustedRenderer；渲染进程只能传
// repositoryId（主进程在 open 时分配的 opaque token），永不传 cwd/命令/参数。
// 写操作（stage/unstage）在服务层用 FRESH status 快照重新校验路径，拒绝
// 绝对路径、..  NUL 及不在快照中的路径。错误统一为脱敏的 GitError。
ipcMain.handle('git:choose-repository', async (event) => {
  assertTrustedRenderer(event)
  // 原生目录选择对话框；用户取消返回 null，不抛错。
  const result = await dialog.showOpenDialog({
    title: '选择 Git 仓库',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('git:open-repository', async (event, absPath: string) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.openRepository(absPath)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:list-recent-repositories', (event) => {
  assertTrustedRenderer(event)
  return gitRepositoryService.listRecent()
})

ipcMain.handle('git:refresh-status', async (event, repositoryId: string) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.getStatus(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:get-diff', async (event, req: { repositoryId: string; path: string; source: 'staged' | 'unstaged' | 'untracked' }) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.getDiff(req)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:stage-files', async (event, repositoryId: string, paths: string[]) => {
  assertTrustedRenderer(event)
  try {
    await gitRepositoryService.stageFiles(repositoryId, paths)
    return await gitRepositoryService.getStatus(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:unstage-files', async (event, repositoryId: string, paths: string[]) => {
  assertTrustedRenderer(event)
  try {
    await gitRepositoryService.unstageFiles(repositoryId, paths)
    return await gitRepositoryService.getStatus(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:list-branches', async (event, repositoryId: string) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.listBranches(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:switch-branch', async (event, input: { repositoryId: string; branch: string }) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.switchBranch(input)
  } catch (e) {
    throw toIpcError(e)
  }
})

// ============ Git Workbench IPC（Task 3：commit / fetch / pull / push）============
// 同样的安全契约：assertTrustedRenderer 先行；渲染进程只传 repositoryId +
// 提交文案，永不传 cwd/命令/参数。所有写操作在服务层做身份/暂存/operation
// 前置校验，失败统一 toIpcError（脱敏）。无 force push / reset --hard / 自动
// 提交+推送链路——每个操作都是独立的用户动作。
ipcMain.handle('git:get-identity', async (event, repositoryId: string) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.getIdentity(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:commit', async (event, input: GitCommitInput) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.commit(input)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:fetch', async (event, repositoryId: string) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.fetch(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:pull', async (event, repositoryId: string) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.pullFfOnly(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:push', async (event, repositoryId: string) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.push(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:list-remotes', async (event, repositoryId: string) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.listRemotes(repositoryId)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:push-upstream', async (event, input: GitPushUpstreamInput) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.pushUpstream(input)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:discard-worktree-files', async (event, repositoryId: string, paths: string[]) => {
  assertTrustedRenderer(event)
  try {
    return await gitRepositoryService.discardWorktreeFiles(repositoryId, paths)
  } catch (e) {
    throw toIpcError(e)
  }
})

ipcMain.handle('git:propose-commit-message', async (event, req: GitCommitProposalRequest) => {
  assertTrustedRenderer(event)
  try {
    // Bridge the closed Git service (staged-only context) + the existing AI
    // platform (configured provider/profile/key). The renderer passes ONLY
    // repositoryId + modelProfileId — no cwd, argv, paths, or diff text.
    const platform = getAiPlatform()
    if (!platform) {
      throw new GitRunnerError('AI_UNAVAILABLE', 'AI 平台未初始化')
    }
    if (!req?.modelProfileId) {
      throw new GitRunnerError('AI_UNAVAILABLE', '未选择 AI Provider，请先在 AI 设置中配置并选择一个')
    }
    // 1. Collect staged-only context (redacted + capped) via the closed service.
    const ctx = await gitRepositoryService.collectStagedContext(req.repositoryId)
    // 2. One-shot provider call → strict zod-validated proposal.
    const proposal = await platform.runtime.proposeCommitMessage({
      modelProfileId: req.modelProfileId,
      system: COMMIT_PROPOSAL_SYSTEM_PROMPT,
      userPrompt: ctx.prompt,
    })
    // 3. Return the editable proposal + transparency metadata.
    return {
      subject: proposal.subject,
      body: proposal.body,
      rationale: proposal.rationale,
      excludedPaths: ctx.excludedPaths,
      cappedPaths: ctx.cappedPaths,
      totalBytes: ctx.totalBytes,
      totalLines: ctx.totalLines,
      truncated: ctx.truncated,
    }
  } catch (e) {
    // ProposeError carries a .code (AI_UNAVAILABLE/AI_PROVIDER_FAILED/
    // AI_SCHEMA_INVALID/COMMAND_TIMEOUT); toIpcError reads .code + .message
    // generically, so no instanceof check is needed.
    throw toIpcError(e)
  }
})

ipcMain.on('diagram:renderer-ready', (event) => {
  assertTrustedRenderer(event)
  diagramRendererReady = true
  if (queuedDiagramOpen && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('diagram:open-requested', queuedDiagramOpen)
    queuedDiagramOpen = null
  }
})
ipcMain.on('diagram:editor-ready', (event, id: string, ready: boolean) => {
  assertTrustedRenderer(event)
  if (ready) {
    readyDiagramEditors.add(id)
    sendPendingExportsFor(id)
  } else {
    readyDiagramEditors.delete(id)
  }
})
ipcMain.on('diagram:export-complete', (event, result: DiagramExportResult) => {
  assertTrustedRenderer(event)
  const pending = pendingDiagramExports.get(result.requestId)
  if (!pending) return
  pendingDiagramExports.delete(result.requestId)
  clearTimeout(pending.timer)
  if (result.error || !result.data) pending.reject(new Error(result.error || '图纸导出没有返回数据'))
  else pending.resolve(result.data)
})

ipcMain.handle('ai-drawio:start', (event) => {
  assertTrustedRenderer(event)
  return startAiDrawioServer()
})

// ============ 自动更新:手动 GitHub Releases 检查 ============
// 不依赖 electron-updater(需打包签名),用原生 fetch 查 latest release,
// 对比 app.getVersion()。有新版则通知渲染进程,用户点"前往下载"在浏览器打开。
const REPO = 'xiay8874-source/rainTool'
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`

/** 简易 semver 比较:按 "." 分段数值比较,支持 "v" 前缀。返回 <0(a<b) / 0 / >0(a>b) */
function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const A = norm(a), B = norm(b)
  const len = Math.max(A.length, B.length)
  for (let i = 0; i < len; i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export type UpdateResult =
  | { hasUpdate: true; version: string; name: string; notes: string; url: string; publishedAt: string; current: string }
  | { hasUpdate: false; current: string; error?: string }

async function checkForUpdates(): Promise<UpdateResult> {
  const current = app.getVersion()
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RainTool-updater' },
    })
    // 404 = 仓库无 release,视为"无更新"而非错误
    if (res.status === 404) return { hasUpdate: false, current }
    if (!res.ok) return { hasUpdate: false, current, error: `GitHub ${res.status}` }
    const r = (await res.json()) as {
      tag_name: string; name: string | null; body: string | null
      html_url: string; published_at: string
    }
    if (compareVersions(r.tag_name, current) <= 0) {
      return { hasUpdate: false, current }
    }
    return {
      hasUpdate: true,
      version: r.tag_name,
      name: r.name ?? r.tag_name,
      notes: r.body ?? '',
      url: r.html_url,
      publishedAt: r.published_at,
      current,
    }
  } catch (e) {
    return { hasUpdate: false, current, error: (e as Error).message }
  }
}

ipcMain.handle('update:check', () => checkForUpdates())

// ============ 应用内自动更新:下载 dmg → 挂载 → 替换 app → relaunch ============
// 不依赖 electron-updater(需 Developer ID 分发签名),改用原生流式下载 + shell 替换。
// 私有仓库 release 资产下载:若环境有 GH_TOKEN 则带 Authorization 头,否则匿名试下
// (匿名对 public repo 可用;私有 repo 会 401,渲染进程会降级提示手动下载)。
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN

ipcMain.handle('update:getLastCheck', () => {
  const u = readData('update') as { lastCheck?: number } | null
  return u?.lastCheck
})
ipcMain.handle('update:setLastCheck', (_e, ts: number) => {
  const u = (readData('update') as { lastCheck?: number } | null) ?? {}
  writeData('update', { ...u, lastCheck: ts })
})

/** 流式下载文件,推送进度。失败 reject。返回本地路径。 */
function downloadFile(
  url: string,
  dest: string,
  onProgress: (percent: number, transferred: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http
    const headers: Record<string, string> = { 'User-Agent': 'RainTool-updater' }
    if (GH_TOKEN) headers.Authorization = `token ${GH_TOKEN}`

    const req = lib.get(url, { headers }, (res) => {
      // 处理重定向(GitHub release 下载会 302 到 objects.githubusercontent.com)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadFile(res.headers.location, dest, onProgress).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`下载失败:HTTP ${res.statusCode}`))
        return
      }
      const total = Number(res.headers['content-length'] ?? 0)
      let transferred = 0
      const ws = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => {
        transferred += chunk.length
        const percent = total > 0 ? Math.round((transferred / total) * 100) : 0
        onProgress(percent, transferred, total)
      })
      res.pipe(ws)
      ws.on('finish', () => ws.close(() => resolve(dest)))
      ws.on('error', (e) => {
        try { unlinkSync(dest) } catch { /* ignore */ }
        reject(e)
      })
    })
    req.on('error', reject)
  })
}

ipcMain.handle('update:download', async (_e, url: string) => {
  // 文件名从 URL 末段取,兜底用固定名
  const name = url.split('/').pop() || 'RainTool-update.dmg'
  const dest = path.join(tmpdir(), name)
  // 同名残留先清,避免 createWriteStream 追加
  if (existsSync(dest)) { try { unlinkSync(dest) } catch { /* ignore */ } }

  await downloadFile(url, dest, (percent, transferred, total) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', { percent, transferred, total })
    }
  })
  return dest
})

/** 执行 shell 命令,resolve(stdout)。失败 reject(带 stderr) */
function runShell(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} 退出码 ${code}: ${stderr.trim()}`))
    })
  })
}

/** 从 hdiutil attach 输出里解析挂载点。输出形如:
 *   /dev/disk4s1  Apple_HFS   /Volumes/RainTool 0.2.3 */
function parseMountPoint(output: string): string | null {
  // 取最后一个非空行,按 tab 分割,最后一段即挂载点
  const lines = output.trim().split('\n').filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return null
  const parts = last.split('\t').map((s) => s.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? null
}

ipcMain.handle('update:install', async (_e, dmgPath: string) => {
  if (!existsSync(dmgPath)) throw new Error('安装包不存在:' + dmgPath)

  // 1. 挂载 dmg
  const attachOut = await runShell('hdiutil', ['attach', dmgPath, '-nobrowse', '-quiet'])
  const mountPoint = parseMountPoint(attachOut)
  if (!mountPoint) throw new Error('无法解析 dmg 挂载点')

  try {
    // 2. 找到挂载卷里的 .app(取第一个)
    const items = await runShell('ls', [mountPoint]).then((s) =>
      s.split('\n').filter((n) => n.endsWith('.app')),
    )
    if (items.length === 0) throw new Error('dmg 内未找到 .app')
    const appSrc = path.join(mountPoint, items[0])
    const appDest = '/Applications/' + items[0]

    // 3. 先删旧 app(避免 cp -R 叠加残留),再拷贝
    await runShell('rm', ['-rf', appDest]).catch(() => { /* 旧 app 不存在无妨 */ })
    await runShell('cp', ['-R', appSrc, appDest])
  } finally {
    // 4. 卸载 dmg(无论拷贝成功与否)
    await runShell('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => { /* ignore */ })
  }

  // 5. 清理 dmg 临时文件
  try { unlinkSync(dmgPath) } catch { /* ignore */ }

  // 6. app.exit 不触发 before-quit：必须显式 flush 并停止 AI 服务
  await Promise.all([flushBeforeExit(), stopAiDrawioServer(), diagramBridge.stop()])

  // 7. relaunch 退出:旧进程退出后由系统拉起新 app
  app.relaunch()
  app.exit(0)
})
// 暴露真实版本号给渲染进程(打包后由 electron 读取 package.json,不再硬编码)
ipcMain.handle('app:getVersion', () => app.getVersion())

// ============ 退出前 flush 工作区 ============
// app.exit(0) 不触发 before-quit(见 Electron 文档),自动更新安装时需显式 flush。
// before-quit 场景(⌘Q/关窗)也复用此机制:发 app:flush → 等渲染进程 app:flushed。
function flushBeforeExit(): Promise<void> {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve(); return }
    const timer = setTimeout(resolve, 2000) // 超时兜底:2s 后无论如何继续
    ipcMain.once('app:flushed', () => { clearTimeout(timer); resolve() })
    mainWindow.webContents.send('app:flush')
  })
}

let shutdownStarted = false
let shutdownDone = false // flush/AI 服务停止后放行，避免 app.quit() 死循环
app.on('before-quit', (e) => {
  if (shutdownDone) return
  e.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  // Abort active AI runs FIRST so outbound streams stop promptly, before
  // awaiting flush/Draw.io/MCP shutdown tasks. Then clear all in-memory
  // attachment payloads (P2: ephemeral context must not survive quit). P4:
  // await MCP client disconnect so child processes (stdio) are closed before
  // the app exits — fire-and-forget would race app.quit() and leak processes.
  getAiPlatform()?.cancelAll('window-closed')
  getAiPlatform()?.clearContextVault()
  Promise.all([
    flushBeforeExit(),
    stopAiDrawioServer(),
    diagramBridge.stop(),
    getAiPlatform()?.disconnectAllMcp() ?? Promise.resolve(),
  ]).finally(() => {
    shutdownDone = true
    app.quit()
  })
})

// 同步兜底；正常退出和自动更新路径都在此之前显式 await stopAiDrawioServer。
app.on('will-quit', () => killAiDrawioServerNow())

function isRainToolMainFrameUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      return path.resolve(fileURLToPath(parsed)) === APP_INDEX_PATH
    }
    if (!VITE_DEV_SERVER_URL) return false
    return parsed.origin === new URL(VITE_DEV_SERVER_URL).origin
  } catch {
    return false
  }
}

function isAllowedEmbeddedFrameUrl(url: string): boolean {
  if (url === 'about:blank' || url.startsWith('blob:') || url.startsWith('data:')) return true
  if (isRainToolMainFrameUrl(url)) return true
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      ['6002', '13370'].includes(parsed.port)
    )
  } catch {
    return false
  }
}

function openExternalSafely(url: string): void {
  if (url.startsWith('https://') || url.startsWith('http://')) {
    void shell.openExternal(url)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#fafafa',
    title: 'RainTool',
    titleBarStyle: 'hiddenInset',
    // 交通灯(关闭/最小化/最大化):嵌入统一顶栏,与三个面板顶部对齐
    // 三个圆点直径 12px,y=14 → 圆心 y=20,底部 y=26,留 2px 余量到 pt-7(28px) 内容区
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev && VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // 子 iframe（Next/Draw.io）也会触发 did-start-loading，不能因此把顶层
  // renderer 标记为未就绪，否则 MCP open/export 会在第一次画布加载后永久排队。
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) diagramRendererReady = false
  })

  // RainTool 顶层不可被嵌入页面导航；AI/Draw.io 外链统一交给系统浏览器。
  mainWindow.webContents.on('will-navigate', (event) => {
    if (isRainToolMainFrameUrl(event.url)) return
    event.preventDefault()
    openExternalSafely(event.url)
  })
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || isAllowedEmbeddedFrameUrl(event.url)) return
    event.preventDefault()
    openExternalSafely(event.url)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedEmbeddedFrameUrl(url)) openExternalSafely(url)
    return { action: 'deny' }
  })
  // draw.io 编辑文本时会注册 beforeunload；退出由 RainTool 的 flush 流程统一控制。
  mainWindow.webContents.on('will-prevent-unload', (event) => event.preventDefault())

  // 右键菜单:仅在文本区(textarea/input/contenteditable)或有选中文字时弹出,
  // 避免与其他右键功能冲突。可编辑区弹完整菜单;只读区只弹复制。
  // 快捷键 ⌘C/⌘X/⌘V/⌘A 由上方 Edit 菜单的 role accelerator 驱动(macOS 必需)。
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return
    const f = params.editFlags
    const template: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'copy', label: '复制', enabled: f.canCopy },
          { role: 'cut', label: '剪切', enabled: f.canCut },
          { role: 'paste', label: '粘贴', enabled: f.canPaste },
          { type: 'separator' },
          { role: 'selectAll', label: '全选', enabled: f.canSelectAll },
        ]
      : [{ role: 'copy', label: '复制', enabled: f.canCopy }]
    Menu.buildFromTemplate(template).popup({ window: mainWindow! })
  })
}

// 注:不调用 app.setName('RainTool') —— 会改变 userData 目录,
// 导致 ~/Library/Application Support/raintool 下的既有状态丢失。
// 改用 productName + 自定义应用菜单设置 macOS 菜单栏显示名。

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  // macOS 应用菜单首项显示 "RainTool"(替代默认的 Electron/raintool)
  const isMac = process.platform === 'darwin'
  const appSubmenu = isMac
    ? [
        { role: 'appMenu', label: 'RainTool' },
        { role: 'services' },
        { role: 'hide', label: '隐藏 RainTool' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: '退出 RainTool' },
      ]
    : [{ role: 'quit', label: '退出 RainTool' }]

  // Edit 菜单:macOS 上 ⌘C/⌘X/⌘V/⌘A/⌘Z 等快捷键由菜单 role 的 accelerator 驱动,
  // 若应用菜单覆盖了默认菜单而不补 Edit,这些快捷键会失效。
  const editSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'undo', label: '撤销' },
    { role: 'redo', label: '重做' },
    { type: 'separator' },
    { role: 'cut', label: '剪切' },
    { role: 'copy', label: '复制' },
    { role: 'paste', label: '粘贴' },
    { role: 'selectAll', label: '全选' },
  ]

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'RainTool', submenu: appSubmenu } as Electron.MenuItemConstructorOptions,
      { label: '编辑', submenu: editSubmenu },
    ]),
  )

  createWindow()
  // AI Platform: initialize after the window exists so IPC can reach it.
  // Data lives under app.getPath('userData')/ai — never a hard-coded home path.
  initAiPlatform({
    mainWindow: () => mainWindow,
    assertTrustedRenderer,
    diagramRepository,
    onDiagramChanged: emitDiagramChanged,
  })
  void diagramBridge.start().catch((error) => {
    console.error('[RainTool MCP] 图纸桥接服务启动失败：', error)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 鼠标后退/前进侧键(macOS):转发给渲染进程做标签导航
// 注:'browser-back-forward' 事件存在于运行时但未在 electron 33 类型定义中
;(app as unknown as {
  on: (event: 'browser-back-forward', listener: (e: Electron.Event, direction: number) => void) => void
}).on('browser-back-forward', (_e, direction) => {
  // direction: -1 = 后退, 1 = 前进
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('nav:mouse', direction)
  }
})
