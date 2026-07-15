/**
 * window.raintool 的统一类型声明。
 *
 * 由 electron/preload.ts 通过 contextBridge.exposeInMainWorld('raintool', ...) 暴露。
 * 此文件消除此前散落在各组件里的 `window as unknown as { raintool?: {...} }` 内联断言,
 * 并保证 App.tsx / SettingsFloat.tsx / store 等多处的调用签名一致。
 *
 * 该 .d.ts 在 src 下,被根 tsconfig.json 的 include: ["src"] 自动纳入类型检查。
 */

/** 检查更新的返回:有新版 / 无新版(可能带 error) */
export type UpdateCheckResult =
  | {
      hasUpdate: true
      version: string
      name: string
      notes: string
      url: string
      publishedAt: string
      current: string
    }
  | { hasUpdate: false; current: string; error?: string }

/** 下载进度事件 payload */
export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
}

export type AiDrawioStartErrorCode =
  | 'PORT_IN_USE'
  | 'MISSING_RESOURCE'
  | 'START_TIMEOUT'
  | 'START_FAILED'

export type AiDrawioStartResult =
  | { status: 'ready'; code: 'READY'; url: string }
  | { status: 'error'; code: AiDrawioStartErrorCode; message: string; details?: string }

export interface RaintoolAPI {
  // 持久化存储(收藏夹 / 配置)
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>

  // 应用版本号(来自 app.getVersion(),打包后读 package.json)
  getVersion: () => Promise<string>

  /** 启动固定的本地 AI Draw.io 服务；不接收端口、路径或命令参数 */
  startAiDrawio: () => Promise<AiDrawioStartResult>

  // 退出前 flush:主进程 before-quit / installUpdate 退出前发 app:flush,
  // 渲染进程 await cb 完成异步保存后回 app:flushed,主进程收到才放行退出
  onFlush: (cb: () => Promise<void>) => void

  // 更新检查:查 GitHub Releases latest,对比版本
  checkForUpdates: () => Promise<UpdateCheckResult>
  getLastCheck: () => Promise<number | undefined>
  setLastCheck: (ts: number) => Promise<void>

  // 应用内下载安装(替代旧的 openReleaseUrl 浏览器跳转)
  /** 下载 dmg 到临时目录,主进程通过 update:progress 事件推送进度。返回本地 dmg 路径 */
  downloadUpdate: (url: string) => Promise<string>
  /** 挂载 dmg → 替换 /Applications/RainTool.app → relaunch 退出 */
  installUpdate: (dmgPath: string) => Promise<void>
  /** 订阅下载进度事件,返回取消订阅函数 */
  onUpdateProgress: (cb: (p: UpdateProgress) => void) => () => void

  // 鼠标后退/前进侧键:订阅方向事件(-1 后退 / 1 前进)
  onMouseNav: (cb: (direction: number) => void) => () => void
}

declare global {
  interface Window {
    raintool: RaintoolAPI
  }
}
