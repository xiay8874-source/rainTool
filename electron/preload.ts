import { contextBridge, ipcRenderer } from 'electron'

// 暴露给渲染进程的持久化 API(收藏夹等)+ 自动更新 API
const api = {
  storeGet: (key: string) => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
  storeDelete: (key: string) => ipcRenderer.invoke('store:delete', key),

  // 自动更新:查 GitHub Releases latest,对比版本
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  openReleaseUrl: (url: string) => ipcRenderer.invoke('update:open', url),
  getLastCheck: () => ipcRenderer.invoke('update:getLastCheck'),
  setLastCheck: (ts: number) => ipcRenderer.invoke('update:setLastCheck', ts),
}

contextBridge.exposeInMainWorld('raintool', api)
