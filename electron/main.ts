import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Store from 'electron-store'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const isDev = !app.isPackaged
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// electron-store v10:default export,ESM 下直接 import
// 类型断言绕过泛型重载推断的复杂性
const store = new Store<Record<string, unknown>>() as unknown as {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

let mainWindow: BrowserWindow | null = null

// 持久化 IPC: 收藏夹 / 配置
ipcMain.handle('store:get', (_e, key: string) => store.get(key))
ipcMain.handle('store:set', (_e, key: string, value: unknown) => {
  store.set(key, value)
})
ipcMain.handle('store:delete', (_e, key: string) => {
  store.delete(key)
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
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'raintool-updater' },
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
ipcMain.handle('update:open', (_e, url: string) => shell.openExternal(url))
ipcMain.handle('update:getLastCheck', () => store.get('update.lastCheck'))
ipcMain.handle('update:setLastCheck', (_e, ts: number) => store.set('update.lastCheck', ts))

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#fafafa',
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
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
