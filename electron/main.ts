import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWriteStream, unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import https from 'node:https'
import http from 'node:http'
import { spawn } from 'node:child_process'

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

  // 右键菜单:复制/剪切/粘贴/全选。
  // 用 role 而非自定义 label+click —— Electron 会原生执行剪贴板操作。
  // 启用状态用 params.editFlags(由 Electron 根据选区/可编辑状态/剪贴板计算):
  //   canCopy/canCut 无选区时为 false;canPaste 仅在可编辑且剪贴板有内容时为 true。
  // 快捷键 ⌘C/⌘X/⌘V/⌘A 由上方 Edit 菜单的 role accelerator 驱动(macOS 必需)。
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const f = params.editFlags
    const menu = Menu.buildFromTemplate([
      { role: 'copy', label: '复制', enabled: f.canCopy },
      { role: 'cut', label: '剪切', enabled: f.canCut },
      { role: 'paste', label: '粘贴', enabled: f.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: '全选', enabled: f.canSelectAll },
    ])
    menu.popup({ window: mainWindow! })
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
