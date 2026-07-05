import { contextBridge, ipcRenderer } from 'electron'

// 暴露给渲染进程的持久化 API(收藏夹等)
const api = {
  storeGet: (key: string) => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
  storeDelete: (key: string) => ipcRenderer.invoke('store:delete', key),
}

contextBridge.exposeInMainWorld('devtoolbox', api)
