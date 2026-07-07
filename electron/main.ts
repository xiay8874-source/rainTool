import { app, BrowserWindow, ipcMain, Menu, globalShortcut, desktopCapturer, screen, nativeImage, dialog, clipboard } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWriteStream, unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import https from 'node:https'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const isDev = !app.isPackaged
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

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

// 持久化 IPC:工作区 / 收藏夹 / 配置(同步 fs 读写,渲染层无感)
ipcMain.handle('store:get', (_e, key: string) => readData(key))
ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
  writeData(key, value)
})
ipcMain.handle('store:delete', (_e, key: string) => {
  deleteData(key)
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

  // 6. relaunch 前先 flush 工作区(app.exit 不触发 before-quit,需显式调)
  await flushBeforeExit()

  // 7. relaunch 退出:旧进程退出后由系统拉起新 app
  app.relaunch()
  app.exit(0)
})
// 暴露真实版本号给渲染进程(打包后由 electron 读取 package.json,不再硬编码)
ipcMain.handle('app:getVersion', () => app.getVersion())

// ============ 截图:快捷键 / 截图引擎 / 贴图窗口 ============

const SCREENSHOTS_DIR = path.join(DATA_DIR, 'tabs', 'screenshots')
try { mkdirSync(SCREENSHOTS_DIR, { recursive: true }) } catch { /* 已存在 */ }

export type CaptureMode = 'region' | 'screen' | 'window'

export interface ShortcutMap {
  captureRegion: string
  captureScreen: string
  captureWindow: string
  togglePins: string
}

const DEFAULT_SHORTCUTS: ShortcutMap = {
  captureRegion: 'CommandOrControl+Shift+A',
  captureScreen: 'CommandOrControl+Shift+S',
  captureWindow: 'CommandOrControl+Shift+W',
  togglePins: 'CommandOrControl+Shift+P',
}

function readShortcuts(): ShortcutMap {
  const stored = readData('settings') as { shortcuts?: Partial<ShortcutMap> } | null
  return { ...DEFAULT_SHORTCUTS, ...(stored?.shortcuts ?? {}) }
}

function writeShortcuts(map: ShortcutMap): void {
  const stored = (readData('settings') as Record<string, unknown> | null) ?? {}
  writeData('settings', { ...stored, shortcuts: map })
}

function registerShortcuts(map: ShortcutMap): void {
  globalShortcut.unregisterAll()
  const entries: [keyof ShortcutMap, () => void][] = [
    ['captureRegion', () => startCapture('region')],
    ['captureScreen', () => startCapture('screen')],
    ['captureWindow', () => startCapture('window')],
    ['togglePins', () => toggleAllPins()],
  ]
  for (const [key, handler] of entries) {
    const accel = map[key]
    if (accel) {
      try {
        globalShortcut.register(accel, handler)
      } catch {
        /* 注册失败忽略(可能系统占用) */
      }
    }
  }
}

ipcMain.handle('shortcut:get', () => readShortcuts())

ipcMain.handle('shortcut:update', (_e, map: ShortcutMap) => {
  writeShortcuts(map)
  registerShortcuts(map)
  return true
})

ipcMain.handle('shortcut:checkConflict', (_e, accel: string) => {
  // 检查快捷键是否被系统或其他应用占用
  // globalShortcut.isRegistered 只能查自己注册的,系统占用的需尝试注册再注销
  if (!accel) return false
  try {
    const ok = globalShortcut.register(accel, () => {})
    if (ok) {
      globalShortcut.unregister(accel)
      return false // 可注册 = 无冲突
    }
    return true // 注册失败 = 被占用
  } catch {
    return true
  }
})

// ---- 贴图窗口管理 ----

interface PinWindowEntry {
  win: BrowserWindow
  tabId: string
  hidden: boolean
}

const pinWindows: PinWindowEntry[] = []

function toggleAllPins(): void {
  const anyVisible = pinWindows.some((p) => !p.hidden)
  for (const entry of pinWindows) {
    if (anyVisible) {
      entry.win.hide()
      entry.hidden = true
    } else {
      entry.win.show()
      entry.hidden = false
    }
  }
}

// ---- 截图引擎 ----

function formatTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 截图落盘:写 PNG + 缩略图,返回 tab 记录(含 id/name/路径) */
async function saveCapture(img: Electron.NativeImage, source: CaptureMode): Promise<{
  id: string
  name: string
  createdAt: number
  source: CaptureMode
  primary: string
  thumb: string
  width: number
  height: number
}> {
  const id = randomUUID()
  const primaryPath = path.join(SCREENSHOTS_DIR, `${id}.png`)
  const thumbPath = path.join(SCREENSHOTS_DIR, `${id}.thumb.png`)

  writeFileSync(primaryPath, img.toPNG())
  const { width, height } = img.getSize()
  const thumb = img.resize({ width: Math.min(200, width) })
  writeFileSync(thumbPath, thumb.toPNG())

  return {
    id, name: `截图 ${formatTimestamp()}`, createdAt: Date.now(),
    source, primary: primaryPath, thumb: thumbPath, width, height,
  }
}

/** 创建贴图窗口并加载截图 */
function createPinWindow(record: {
  id: string
  name: string
  primary: string
  width: number
  height: number
}, x?: number, y?: number): void {
  const win = new BrowserWindow({
    width: record.width,
    height: record.height,
    x: x ?? undefined,
    y: y ?? undefined,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'pin-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const entry: PinWindowEntry = { win, tabId: record.id, hidden: false }
  pinWindows.push(entry)

  win.on('closed', () => {
    const idx = pinWindows.findIndex((p) => p.win === win)
    if (idx >= 0) pinWindows.splice(idx, 1)
  })

  if (isDev && VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL.replace(/\/$/, '') + '/pin.html')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'pin.html'))
  }

  // 传递截图信息给贴图窗口
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('pin:load', {
      id: record.id,
      name: record.name,
      filePath: record.primary,
    })
  })
}

async function startCapture(mode: CaptureMode): Promise<void> {
  try {
    const sources = await desktopCapturer.getSources({
      types: mode === 'window' ? ['window'] : ['screen'],
      thumbnailSize: { width: 9999, height: 9999 },
      fetchWindowIcons: false,
    })

    if (mode === 'screen') {
      for (const s of sources) {
        const img = s.thumbnail
        if (img.isEmpty()) continue
        const record = await saveCapture(img, 'screen')
        createPinWindow(record)
      }
      return
    }

    if (mode === 'window') {
      // 单显示器:取第一个窗口源
      if (sources.length === 0) return
      // 若多窗口,取第一个(活动窗口)
      const s = sources[0]
      const img = s.thumbnail
      if (img.isEmpty()) return
      const record = await saveCapture(img, 'window')
      createPinWindow(record)
      return
    }

    // region:创建选区覆盖窗口
    await startRegionCapture(sources)
  } catch (e) {
    console.error('截图失败:', e)
  }
}

// ---- 区域截图:选区覆盖窗口 ----

let overlayWindows: BrowserWindow[] = []

async function startRegionCapture(sources: Electron.DesktopCapturerSource[]): Promise<void> {
  // 清理旧覆盖窗口
  closeOverlays()

  const displays = screen.getAllDisplays()

  for (const display of displays) {
    const { x, y, width, height } = display.bounds
    const overlay = new BrowserWindow({
      x, y, width, height,
      frame: false,
      fullscreen: false,
      alwaysOnTop: true,
      movable: false,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    overlayWindows.push(overlay)

    overlay.on('closed', () => {
      overlayWindows = overlayWindows.filter((w) => w !== overlay)
    })

    if (isDev && VITE_DEV_SERVER_URL) {
      overlay.loadURL(VITE_DEV_SERVER_URL.replace(/\/$/, '') + '/overlay.html')
    } else {
      overlay.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'))
    }

    // 传递显示器信息和对应截图
    overlay.webContents.on('did-finish-load', () => {
      const matchingSource = sources.find((s) => {
        return s.display_id === String(display.id) || sources.indexOf(s) === displays.indexOf(display)
      }) ?? sources[displays.indexOf(display)] ?? sources[0]

      overlay.webContents.send('overlay:init', {
        display: { x, y, width, height, id: display.id },
        imageData: matchingSource?.thumbnail.toDataURL() ?? null,
      })
    })
  }
}

function closeOverlays(): void {
  for (const w of overlayWindows) {
    if (!w.isDestroyed()) w.close()
  }
  overlayWindows = []
}

// 选区完成:从全屏图裁剪
ipcMain.handle('capture:region-select', async (_e, selection: {
  x: number; y: number; width: number; height: number; displayId: number
}) => {
  closeOverlays()

  // 找到对应显示器的全屏截图
  const displays = screen.getAllDisplays()
  const displayIdx = displays.findIndex((d) => d.id === selection.displayId)
  if (displayIdx < 0) return null

  // 重新截取该显示器全屏图(overlay 传来的 imageData 已在 overlay 关闭后失效)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 9999, height: 9999 },
    fetchWindowIcons: false,
  })

  // 匹配显示器(按 display_id 或索引)
  const source = sources.find((s) => s.display_id === String(selection.displayId)) ?? sources[displayIdx] ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) return null

  const fullImg = source.thumbnail
  const fullSize = fullImg.getSize()

  // 显示器缩放比:desktopCapturer 截图可能是 2x(retina),需要换算
  const display = displays[displayIdx]
  const scaleFactor = display.scaleFactor || 1

  const cropX = Math.max(0, Math.round(selection.x * scaleFactor))
  const cropY = Math.max(0, Math.round(selection.y * scaleFactor))
  const cropW = Math.min(Math.round(selection.width * scaleFactor), fullSize.width - cropX)
  const cropH = Math.min(Math.round(selection.height * scaleFactor), fullSize.height - cropY)

  if (cropW <= 0 || cropH <= 0) return null

  const cropped = fullImg.crop({ x: cropX, y: cropY, width: cropW, height: cropH })

  const record = await saveCapture(cropped, 'region')
  createPinWindow(record, display.bounds.x + selection.x, display.bounds.y + selection.y)
  return record.id
})

ipcMain.handle('capture:cancel', () => {
  closeOverlays()
  return true
})

// 贴图窗口:保存到历史(写图层数据 + 通知主窗口)
ipcMain.handle('pin:save-to-history', async (_e, payload: {
  tabId: string
  layersJson: string | null
  mergedDataUrl: string | null
}) => {
  const { tabId, layersJson, mergedDataUrl } = payload
  const layersPath = path.join(SCREENSHOTS_DIR, `${tabId}.json`)
  if (layersJson) {
    writeFileSync(layersPath, layersJson)
  }
  // 若有合并图(含标注),覆盖原 PNG + 重新生成缩略图
  if (mergedDataUrl) {
    const primaryPath = path.join(SCREENSHOTS_DIR, `${tabId}.png`)
    const thumbPath = path.join(SCREENSHOTS_DIR, `${tabId}.thumb.png`)
    const img = nativeImage.createFromDataURL(mergedDataUrl)
    writeFileSync(primaryPath, img.toPNG())
    const thumb = img.resize({ width: Math.min(200, img.getSize().width) })
    writeFileSync(thumbPath, thumb.toPNG())
  }
  return true
})

// 贴图窗口:关闭
ipcMain.handle('pin:close', (_e, tabId: string) => {
  const entry = pinWindows.find((p) => p.tabId === tabId)
  if (entry && !entry.win.isDestroyed()) entry.win.close()
  return true
})

// 另存为:弹系统对话框
ipcMain.handle('screenshot:saveAs', async (_e, payload: { sourcePath: string; defaultName: string }) => {
  const { sourcePath, defaultName } = payload
  if (!existsSync(sourcePath)) return null
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultName.endsWith('.png') ? defaultName : `${defaultName}.png`,
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  })
  if (canceled || !filePath) return null
  const data = readFileSync(sourcePath)
  writeFileSync(filePath, data)
  return filePath
})

// 复制图片到剪贴板
ipcMain.handle('screenshot:copyToClipboard', (_e, filePath: string) => {
  if (!existsSync(filePath)) return false
  const img = nativeImage.createFromPath(filePath)
  clipboard.writeImage(img)
  return true
})

// 读取截图文件为 base64(供编辑器/历史墙加载)
ipcMain.handle('screenshot:readFile', (_e, filePath: string) => {
  if (!existsSync(filePath)) return null
  const data = readFileSync(filePath)
  return 'data:image/png;base64,' + data.toString('base64')
})

// 删除截图记录(磁盘文件 + 索引由 store 处理)
ipcMain.handle('screenshot:deleteFiles', (_e, tabId: string) => {
  const dir = SCREENSHOTS_DIR
  for (const suffix of ['.png', '.thumb.png', '.json']) {
    const p = path.join(dir, `${tabId}${suffix}`)
    try { unlinkSync(p) } catch { /* 不存在无妨 */ }
  }
  return true
})

// 保存编辑器结果(写图层 JSON + 覆盖合并图 PNG + 重新生成缩略图)
ipcMain.handle('screenshot:save', async (_e, payload: {
  tabId: string
  layersJson: string
  mergedDataUrl: string
}) => {
  const { tabId, layersJson, mergedDataUrl } = payload
  const layersPath = path.join(SCREENSHOTS_DIR, `${tabId}.json`)
  const primaryPath = path.join(SCREENSHOTS_DIR, `${tabId}.png`)
  const thumbPath = path.join(SCREENSHOTS_DIR, `${tabId}.thumb.png`)

  // 写图层 JSON
  writeFileSync(layersPath, layersJson)

  // 覆盖合并图 PNG
  const img = nativeImage.createFromDataURL(mergedDataUrl)
  writeFileSync(primaryPath, img.toPNG())

  // 重新生成缩略图
  const thumb = img.resize({ width: Math.min(200, img.getSize().width) })
  writeFileSync(thumbPath, thumb.toPNG())

  return true
})

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

let isFlushing = false
let flushDone = false // flush 已完成,后续 before-quit 直接放行(避免 app.quit() 死循环)
app.on('before-quit', (e) => {
  if (flushDone || !mainWindow || mainWindow.isDestroyed()) return
  if (isFlushing) return
  e.preventDefault()
  isFlushing = true
  const timer = setTimeout(() => { flushDone = true; isFlushing = false; app.quit() }, 1500)
  ipcMain.once('app:flushed', () => {
    clearTimeout(timer)
    flushDone = true
    isFlushing = false
    app.quit()
  })
  mainWindow.webContents.send('app:flush')
})

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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev && VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

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

  // 注册截图全局快捷键
  registerShortcuts(readShortcuts())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})

// 应用退出前注销所有全局快捷键
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
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
