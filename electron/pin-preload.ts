import { contextBridge, ipcRenderer } from 'electron'

// 贴图窗口的 preload:暴露贴图专用 API
const api = {
  // 接收主进程传来的截图信息
  onPinLoad: (cb: (data: { id: string; name: string; filePath: string }) => void) => {
    const listener = (_e: unknown, data: { id: string; name: string; filePath: string }) => cb(data)
    ipcRenderer.on('pin:load', listener)
    return () => ipcRenderer.removeListener('pin:load', listener)
  },

  // 读取图片文件为 dataURL
  readFile: (filePath: string) => ipcRenderer.invoke('screenshot:readFile', filePath),

  // 复制图片到剪贴板
  copyToClipboard: (filePath: string) => ipcRenderer.invoke('screenshot:copyToClipboard', filePath),

  // 另存为
  saveAs: (sourcePath: string, defaultName: string) =>
    ipcRenderer.invoke('screenshot:saveAs', { sourcePath, defaultName }),

  // 保存到历史(写图层 JSON + 覆盖合并图 dataURL)
  saveToHistory: (tabId: string, layersJson: string | null, mergedDataUrl: string | null) =>
    ipcRenderer.invoke('pin:save-to-history', { tabId, layersJson, mergedDataUrl }),

  // 关闭贴图窗口
  close: (tabId: string) => ipcRenderer.invoke('pin:close', tabId),
}

contextBridge.exposeInMainWorld('pin', api)
