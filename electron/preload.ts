import { contextBridge, ipcRenderer } from 'electron'
import type { AiDrawioStartResult } from './ai-drawio-types.js'
import type {
  DiagramChangedEvent,
  DiagramCreateInput,
  DiagramDeletedEvent,
  DiagramDocument,
  DiagramDuplicateInput,
  DiagramExportRequest,
  DiagramExportResult,
  DiagramListQuery,
  DiagramListResult,
  DiagramOpenRequest,
  DiagramRevisionMetadata,
  DiagramUpdateInput,
  DiagramUpdateResult,
  LegacyDiagramInput,
  LegacyDiagramMigrationResult,
} from './diagram-types.js'

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

  // AI Draw.io:仅暴露固定服务的启动动作，不接收路径、端口或命令参数
  startAiDrawio: (): Promise<AiDrawioStartResult> => ipcRenderer.invoke('ai-drawio:start'),

  // 图纸库：外层 RainTool 与内嵌 Draw.io、MCP 共用同一份 diagramId 数据。
  listDiagrams: (query: DiagramListQuery = {}): Promise<DiagramListResult> =>
    ipcRenderer.invoke('diagram:list', query),
  getDiagram: (id: string): Promise<DiagramDocument | null> => ipcRenderer.invoke('diagram:get', id),
  createDiagram: (input: DiagramCreateInput = {}): Promise<DiagramDocument> =>
    ipcRenderer.invoke('diagram:create', input),
  updateDiagram: (input: DiagramUpdateInput): Promise<DiagramUpdateResult> =>
    ipcRenderer.invoke('diagram:update', input),
  duplicateDiagram: (input: DiagramDuplicateInput): Promise<DiagramDocument> =>
    ipcRenderer.invoke('diagram:duplicate', input),
  deleteDiagram: (id: string): Promise<boolean> => ipcRenderer.invoke('diagram:delete', id),
  listDiagramRevisions: (id: string): Promise<DiagramRevisionMetadata[]> =>
    ipcRenderer.invoke('diagram:list-revisions', id),
  restoreDiagramRevision: (id: string, revision: number, expectedRevision?: number): Promise<DiagramDocument> =>
    ipcRenderer.invoke('diagram:restore-revision', id, revision, expectedRevision),
  migrateLegacyDiagrams: (items: LegacyDiagramInput[]): Promise<LegacyDiagramMigrationResult> =>
    ipcRenderer.invoke('diagram:migrate-legacy', items),
  setActiveDiagram: (id: string | null): Promise<void> => ipcRenderer.invoke('diagram:set-active', id),
  setDiagramRendererReady: () => ipcRenderer.send('diagram:renderer-ready'),
  setDiagramEditorReady: (id: string, ready: boolean) => ipcRenderer.send('diagram:editor-ready', id, ready),
  completeDiagramExport: (result: DiagramExportResult) => ipcRenderer.send('diagram:export-complete', result),
  onDiagramChanged: (cb: (event: DiagramChangedEvent) => void) => {
    const listener = (_e: unknown, event: DiagramChangedEvent) => cb(event)
    ipcRenderer.on('diagram:changed', listener)
    return () => ipcRenderer.removeListener('diagram:changed', listener)
  },
  onDiagramDeleted: (cb: (event: DiagramDeletedEvent) => void) => {
    const listener = (_e: unknown, event: DiagramDeletedEvent) => cb(event)
    ipcRenderer.on('diagram:deleted', listener)
    return () => ipcRenderer.removeListener('diagram:deleted', listener)
  },
  onDiagramOpenRequested: (cb: (request: DiagramOpenRequest) => void) => {
    const listener = (_e: unknown, request: DiagramOpenRequest) => cb(request)
    ipcRenderer.on('diagram:open-requested', listener)
    return () => ipcRenderer.removeListener('diagram:open-requested', listener)
  },
  onDiagramExportRequested: (cb: (request: DiagramExportRequest) => void) => {
    const listener = (_e: unknown, request: DiagramExportRequest) => cb(request)
    ipcRenderer.on('diagram:export-requested', listener)
    return () => ipcRenderer.removeListener('diagram:export-requested', listener)
  },

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
}

contextBridge.exposeInMainWorld('raintool', api)
