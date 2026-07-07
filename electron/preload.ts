import { contextBridge, ipcRenderer } from 'electron'

// 暴露给渲染进程的持久化 API(收藏夹等)+ 自动更新 API + 鼠标导航
const api = {
  storeGet: (key: string) => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
  storeDelete: (key: string) => ipcRenderer.invoke('store:delete', key),

  // 自动更新:查 GitHub Releases latest,对比版本
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  getLastCheck: () => ipcRenderer.invoke('update:getLastCheck'),
  setLastCheck: (ts: number) => ipcRenderer.invoke('update:setLastCheck'),

  // 应用内下载安装(替代旧的浏览器跳转)
  // downloadUpdate 返回本地 dmg 路径;下载进度通过 onUpdateProgress 订阅
  downloadUpdate: (url: string) => ipcRenderer.invoke('update:download', url),
  installUpdate: (dmgPath: string) => ipcRenderer.invoke('update:install', dmgPath),
  onUpdateProgress: (cb: (p: { percent: number; transferred: number; total: number }) => void) => {
    const listener = (_e: unknown, p: { percent: number; transferred: number; total: number }) => cb(p)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.removeListener('update:progress', listener)
  },

  // 应用版本号(来自 app.getVersion(),打包后读 package.json)
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // 退出前 flush:主进程 before-quit / installUpdate 退出前发 app:flush,
  // 渲染进程执行完异步保存后回 app:flushed,主进程收到后才放行退出
  onFlush: (cb: () => Promise<void>) => {
    ipcRenderer.on('app:flush', async () => {
      try { await cb() } catch { /* flush 失败不阻塞退出 */ }
      ipcRenderer.send('app:flushed')
    })
  },

  // 鼠标后退/前进侧键:订阅方向事件(-1 后退 / 1 前进)
  onMouseNav: (cb: (direction: number) => void) => {
    const listener = (_e: unknown, direction: number) => cb(direction)
    ipcRenderer.on('nav:mouse', listener)
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener('nav:mouse', listener)
  },

  // ===== 截图功能 =====
  // 快捷键:读取 / 更新(主进程重新注册) / 冲突检测
  getShortcuts: () => ipcRenderer.invoke('shortcut:get'),
  updateShortcuts: (map: Record<string, string>) => ipcRenderer.invoke('shortcut:update', map),
  checkShortcutConflict: (accel: string) => ipcRenderer.invoke('shortcut:checkConflict', accel),

  // 截图文件读取(返回 dataURL)
  readScreenshotFile: (filePath: string) => ipcRenderer.invoke('screenshot:readFile', filePath),

  // 另存为(弹系统对话框)
  saveScreenshotAs: (sourcePath: string, defaultName: string) =>
    ipcRenderer.invoke('screenshot:saveAs', { sourcePath, defaultName }),

  // 复制图片到剪贴板
  copyScreenshotToClipboard: (filePath: string) =>
    ipcRenderer.invoke('screenshot:copyToClipboard', filePath),

  // 删除截图磁盘文件
  deleteScreenshotFiles: (tabId: string) => ipcRenderer.invoke('screenshot:deleteFiles', tabId),

  // 保存编辑器结果(写图层 JSON + 覆盖合并图 + 重新生成缩略图)
  saveScreenshot: (tabId: string, layersJson: string, mergedDataUrl: string) =>
    ipcRenderer.invoke('screenshot:save', { tabId, layersJson, mergedDataUrl }),

  // ===== 区域截图选区窗口(overlay) =====
  // 接收主进程的初始化数据(显示器信息 + 截图 dataURL)
  onOverlayInit: (cb: (data: { display: { x: number; y: number; width: number; height: number; id: number }; imageData: string | null }) => void) => {
    const listener = (_e: unknown, data: { display: { x: number; y: number; width: number; height: number; id: number }; imageData: string | null }) => cb(data)
    ipcRenderer.on('overlay:init', listener)
    return () => ipcRenderer.removeListener('overlay:init', listener)
  },
  // 确认选区,提交给主进程裁剪
  confirmRegionCapture: (selection: { x: number; y: number; width: number; height: number; displayId: number }) =>
    ipcRenderer.invoke('capture:region-select', selection),
  // 取消截图
  cancelCapture: () => ipcRenderer.invoke('capture:cancel'),

  // 截图创建完成通知(主进程 → 主窗口,通知 screenshots store 添加记录)
  onScreenshotCreated: (cb: (record: unknown) => void) => {
    const listener = (_e: unknown, record: unknown) => cb(record)
    ipcRenderer.on('screenshot:created', listener)
    return () => ipcRenderer.removeListener('screenshot:created', listener)
  },
}

contextBridge.exposeInMainWorld('raintool', api)
