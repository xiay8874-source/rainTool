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
} from '../../electron/diagram-types'
import type {
  AiConversation,
  AiConversationSummary,
  AiCredentialStatus,
  AiModelProfile,
  AiProfileInput,
  AiRunEvent,
  AiRunMode,
  AiSaveCredentialResult,
  AiStartRunRequest,
} from '../../electron/ai-platform/ai-types'
import type {
  AiAttachmentInput,
  AiAttachmentMeta,
  AiArtifactDocument,
  AiArtifactInput,
  AiArtifactJsonValidation,
  AiArtifactMeta,
} from '../../electron/ai-platform/ai-context-types'
import type {
  AiApplyAck,
  AiAuditEntry,
  AiAuditFilter,
  AiToolMeta,
  AiApprovalToken,
} from '../../electron/ai-platform/ai-tool-types'
import type {
  AiMcpConfirmationRequest,
  AiMcpServerConfig,
  AiMcpServerEvent,
  AiMcpToolMeta,
} from '../../electron/ai-platform/ai-mcp-types'

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

  // 统一图纸库
  listDiagrams: (query?: DiagramListQuery) => Promise<DiagramListResult>
  getDiagram: (id: string) => Promise<DiagramDocument | null>
  createDiagram: (input?: DiagramCreateInput) => Promise<DiagramDocument>
  updateDiagram: (input: DiagramUpdateInput) => Promise<DiagramUpdateResult>
  duplicateDiagram: (input: DiagramDuplicateInput) => Promise<DiagramDocument>
  deleteDiagram: (id: string) => Promise<boolean>
  listDiagramRevisions: (id: string) => Promise<DiagramRevisionMetadata[]>
  restoreDiagramRevision: (id: string, revision: number, expectedRevision?: number) => Promise<DiagramDocument>
  migrateLegacyDiagrams: (items: LegacyDiagramInput[]) => Promise<LegacyDiagramMigrationResult>
  setActiveDiagram: (id: string | null) => Promise<void>
  setDiagramRendererReady: () => void
  setDiagramEditorReady: (id: string, ready: boolean) => void
  completeDiagramExport: (result: DiagramExportResult) => void
  onDiagramChanged: (cb: (event: DiagramChangedEvent) => void) => () => void
  onDiagramDeleted: (cb: (event: DiagramDeletedEvent) => void) => () => void
  onDiagramOpenRequested: (cb: (request: DiagramOpenRequest) => void) => () => void
  onDiagramExportRequested: (cb: (request: DiagramExportRequest) => void) => () => void

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

  // ============ AI 助手（P1）============
  aiListConversations: () => Promise<AiConversationSummary[]>
  aiGetConversation: (id: string) => Promise<AiConversation | null>
  aiCreateConversation: (input: { title?: string; modelProfileId: string; mode?: AiRunMode }) => Promise<AiConversation>
  aiDeleteConversation: (id: string) => Promise<boolean>
  aiSetConversationTitle: (id: string, title: string) => Promise<AiConversation | null>

  aiListProfiles: () => Promise<AiModelProfile[]>
  aiCreateProfile: (input: AiProfileInput) => Promise<AiModelProfile>
  aiDeleteProfile: (id: string) => Promise<boolean>

  /** 凭据状态只返回掩码；原始 key 永不回传 */
  aiCredentialStatus: (credentialKey: string) => Promise<AiCredentialStatus>
  aiSaveCredential: (credentialKey: string, rawKey: string) => Promise<AiSaveCredentialResult>
  aiDeleteCredential: (credentialKey: string) => Promise<AiCredentialStatus>
  aiNewCredentialKey: () => Promise<string>

  aiStartRun: (request: AiStartRunRequest) => Promise<{ runId: string; accepted: boolean }>
  aiCancelRun: (runId: string) => Promise<boolean>
  onAiRunEvent: (cb: (event: AiRunEvent) => void) => () => void

  // P2 上下文保险库：附件原始文本永不回传，仅返回元数据
  aiContextIngest: (input: AiAttachmentInput) => Promise<AiAttachmentMeta>
  aiContextList: () => Promise<AiAttachmentMeta[]>
  aiContextDelete: (id: string) => Promise<boolean>
  aiContextClearAll: () => Promise<boolean>

  // P2 Artifacts：只读提案，无 apply/writeback 动作
  aiArtifactList: () => Promise<AiArtifactMeta[]>
  aiArtifactGet: (id: string) => Promise<AiArtifactDocument | null>
  aiArtifactCreate: (input: AiArtifactInput) => Promise<AiArtifactDocument>
  aiArtifactDelete: (id: string) => Promise<boolean>
  aiArtifactValidateJson: (content: string) => Promise<AiArtifactJsonValidation>

  // P3 工具/审批/审计/应用：窄 API，无审计 clear
  /** 工具元数据列表（无 executor/schema）。 */
  aiToolList: () => Promise<AiToolMeta[]>
  /** 唯一的审批路径；拒绝必须提供非空原因。返回更新后的 token。 */
  aiApprovalDecide: (token: string, approved: boolean, reason?: string) => Promise<AiApprovalToken>
  /** 当前 pending 的审批 token 列表。 */
  aiApprovalListPending: () => Promise<AiApprovalToken[]>
  /** 审计日志只读列表（无 clear/append IPC）。过滤器 Zod 严格校验。 */
  aiAuditList: (filter?: AiAuditFilter) => Promise<AiAuditEntry[]>
  /**
   * 应用确认：渲染进程处理完 apply-request 后回 ack。必须携带
   * targetScope/contentHash/revision，主进程与待处理请求逐一比对；不匹配/
   * 未知/重复的 ack 被拒绝（IPC 抛错）。渲染进程无法伪造执行。
   */
  aiApplyAck: (ack: AiApplyAck) => Promise<boolean>

  // P4 MCP Client：窄 API，渲染进程永不 spawn/connect MCP
  /** 列出已配置的 MCP 服务器元数据（含状态/工具数；无 executor/stderr/instructions）。 */
  aiMcpList: () => Promise<AiMcpServerConfig[]>
  /** 列出某服务器的已发现工具（inventory-only，P4 不可执行）。 */
  aiMcpListTools: (serverId: string) => Promise<AiMcpToolMeta[]>
  /** 添加用户 stdio 候选（存为 pending-confirmation，需主进程确认才能激活）。 */
  aiMcpAddStdio: (input: { displayName: string; command: string; args: string[] }) => Promise<AiMcpServerConfig>
  /** 添加 loopback HTTP 候选（仅 127.0.0.1/localhost；存为 pending-confirmation）。 */
  aiMcpAddLoopback: (input: { displayName: string; url: string }) => Promise<AiMcpServerConfig>
  /** 添加/刷新内置 RainTool MCP（路径由主进程解析，渲染进程不可指定）。 */
  aiMcpAddBundled: () => Promise<AiMcpServerConfig>
  /** 为主进程拥有的单次 TTL 确认构建请求（渲染进程仅展示 command/args/url + 风险）。 */
  aiMcpBuildConfirmation: (serverId: string) => Promise<AiMcpConfirmationRequest | null>
  /** 确认激活（nonce + 指纹必须匹配主进程待处理项；配置变更即失效）。 */
  aiMcpConfirm: (serverId: string, nonce: string) => Promise<boolean>
  /** 启用 + 连接（user-stdio 需先确认激活）。 */
  aiMcpEnable: (serverId: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** 禁用 + 断开（幂等）。 */
  aiMcpDisable: (serverId: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** 重连（断开后重连；幂等）。 */
  aiMcpReconnect: (serverId: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** 删除服务器（先断开再移除配置）。 */
  aiMcpDelete: (serverId: string) => Promise<boolean>
  /** 订阅 MCP 服务器状态变更事件。 */
  onMcpEvent: (cb: (event: AiMcpServerEvent) => void) => () => void
}

declare global {
  interface Window {
    raintool: RaintoolAPI
  }
}
