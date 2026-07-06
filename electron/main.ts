import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron'
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
ipcMain.handle('update:open', (_e, url: string) => shell.openExternal(url))
ipcMain.handle('update:getLastCheck', () => store.get('update.lastCheck'))
ipcMain.handle('update:setLastCheck', (_e, ts: number) => store.set('update.lastCheck', ts))
// 暴露真实版本号给渲染进程(打包后由 electron 读取 package.json,不再硬编码)
ipcMain.handle('app:getVersion', () => app.getVersion())

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
  // 快捷键(Cmd+C/X/V/A)由浏览器原生处理,无需额外绑定。
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
  const submenu = isMac
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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ label: 'RainTool', submenu } as Electron.MenuItemConstructorOptions]),
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
