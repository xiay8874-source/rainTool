import { contextBridge, ipcRenderer } from 'electron'
import type { AiDrawioStartResult } from './ai-drawio-types.js'
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
  AiSupplier,
  AiSupplierInput,
} from './ai-platform/ai-types.js'
import type {
  AiAttachmentInput,
  AiAttachmentMeta,
  AiArtifactDocument,
  AiArtifactInput,
  AiArtifactJsonValidation,
  AiArtifactMeta,
} from './ai-platform/ai-context-types.js'
import type {
  AiApplyAck,
  AiAuditEntry,
  AiAuditFilter,
  AiToolMeta,
  AiApprovalToken,
} from './ai-platform/ai-tool-types.js'
import type {
  AiMcpConfirmationRequest,
  AiMcpServerConfig,
  AiMcpServerEvent,
  AiMcpToolMeta,
} from './ai-platform/ai-mcp-types.js'
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
import type {
  GitBranchListResult,
  GitCommitInput,
  GitCommitProposalRequest,
  GitCommitProposalResult,
  GitCommitResult,
  GitDiffRequest,
  GitDiffResult,
  GitIdentity,
  GitPushUpstreamInput,
  GitRecentRepository,
  GitRemoteListResult,
  GitRepositoryHandle,
  GitStatus,
  GitSwitchBranchInput,
  GitSyncResult,
} from './git-types.js'

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

  // ============ AI 助手（P1）：窄 API，原始密钥永不回传 ============
  aiListConversations: (): Promise<AiConversationSummary[]> =>
    ipcRenderer.invoke('ai:conversation:list'),
  aiGetConversation: (id: string): Promise<AiConversation | null> =>
    ipcRenderer.invoke('ai:conversation:get', id),
  aiCreateConversation: (input: { title?: string; modelProfileId: string; mode?: AiRunMode }): Promise<AiConversation> =>
    ipcRenderer.invoke('ai:conversation:create', input),
  aiDeleteConversation: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:conversation:delete', id),
  aiSetConversationTitle: (id: string, title: string): Promise<AiConversation | null> =>
    ipcRenderer.invoke('ai:conversation:set-title', id, title),

  aiListProfiles: (): Promise<AiModelProfile[]> =>
    ipcRenderer.invoke('ai:profile:list'),
  aiCreateProfile: (input: AiProfileInput): Promise<AiModelProfile> =>
    ipcRenderer.invoke('ai:profile:create', input),
  aiDeleteProfile: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:profile:delete', id),
  // P0-1: atomic enable toggle — touches only `enabled`, never re-upserts the
  // whole profile (avoids clobbering supplier-owned fields + duplicate risk).
  aiSetProfileEnabled: (id: string, enabled: boolean): Promise<AiModelProfile> =>
    ipcRenderer.invoke('ai:profile:set-enabled', id, enabled),

  // P0-1: suppliers (provider configs: base URL + protocol + credential + enable).
  // The settings page groups models by supplier; disabling a supplier excludes
  // all its models from AI assistant + Git AI. aiSupplierSave is transactional:
  // credential persisted first, supplier upserted only on success (no orphan).
  aiListSuppliers: (): Promise<AiSupplier[]> =>
    ipcRenderer.invoke('ai:supplier:list'),
  aiUpsertSupplier: (input: AiSupplierInput): Promise<AiSupplier> =>
    ipcRenderer.invoke('ai:supplier:upsert', input),
  aiDeleteSupplier: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:supplier:delete', id),
  aiSetSupplierEnabled: (id: string, enabled: boolean): Promise<AiSupplier> =>
    ipcRenderer.invoke('ai:supplier:set-enabled', id, enabled),
  aiSaveSupplier: (input: { supplier: AiSupplierInput; rawKey?: string }): Promise<
    | { ok: true; supplier: AiSupplier; status: AiCredentialStatus }
    | { ok: false; reason: 'encryption-unavailable' }
  > =>
    ipcRenderer.invoke('ai:supplier:save', input),

  // 凭据：只返回掩码状态；保存时把原始 key 发给主进程，主进程加密后丢弃明文。
  aiCredentialStatus: (credentialKey: string): Promise<AiCredentialStatus> =>
    ipcRenderer.invoke('ai:credential:status', credentialKey),
  aiSaveCredential: (credentialKey: string, rawKey: string): Promise<AiSaveCredentialResult> =>
    ipcRenderer.invoke('ai:credential:save', credentialKey, rawKey),
  aiDeleteCredential: (credentialKey: string): Promise<AiCredentialStatus> =>
    ipcRenderer.invoke('ai:credential:delete', credentialKey),
  aiNewCredentialKey: (): Promise<string> =>
    ipcRenderer.invoke('ai:credential:new-key'),

  // 运行：start 同步返回 runId（runtime 先分配 run 再后台流式），事件通过 ai:run:event 推送。
  aiStartRun: (request: AiStartRunRequest): Promise<{ runId: string; accepted: boolean }> =>
    ipcRenderer.invoke('ai:run:start', request),
  aiCancelRun: (runId: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:run:cancel', runId),
  onAiRunEvent: (cb: (event: AiRunEvent) => void) => {
    const listener = (_e: unknown, event: AiRunEvent) => cb(event)
    ipcRenderer.on('ai:run:event', listener)
    return () => ipcRenderer.removeListener('ai:run:event', listener)
  },

  // ============ P2 上下文保险库：附件原始文本永不回传，仅返回元数据 ============
  aiContextIngest: (input: AiAttachmentInput): Promise<AiAttachmentMeta> =>
    ipcRenderer.invoke('ai:context:ingest', input),
  aiContextList: (): Promise<AiAttachmentMeta[]> =>
    ipcRenderer.invoke('ai:context:list'),
  aiContextDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:context:delete', id),
  aiContextClearAll: (): Promise<boolean> =>
    ipcRenderer.invoke('ai:context:clear-all'),

  // ============ P2 Artifacts：只读提案，无 apply/writeback 动作 ============
  aiArtifactList: (): Promise<AiArtifactMeta[]> =>
    ipcRenderer.invoke('ai:artifact:list'),
  aiArtifactGet: (id: string): Promise<AiArtifactDocument | null> =>
    ipcRenderer.invoke('ai:artifact:get', id),
  aiArtifactCreate: (input: AiArtifactInput): Promise<AiArtifactDocument> =>
    ipcRenderer.invoke('ai:artifact:create', input),
  aiArtifactDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:artifact:delete', id),
  aiArtifactValidateJson: (content: string): Promise<AiArtifactJsonValidation> =>
    ipcRenderer.invoke('ai:artifact:validate-json', content),

  // ============ P3 工具/审批/审计/应用：窄 API，无审计 clear ============
  // 工具注册表：仅返回元数据（id/title/componentId/risk/description），不暴露 executor。
  aiToolList: (): Promise<AiToolMeta[]> =>
    ipcRenderer.invoke('ai:tool:list'),

  // 审批：decide 是唯一的批准路径；拒绝必须提供非空原因。
  // 主进程校验原因（受限内容拒绝、过长截断），返回更新后的 token。
  aiApprovalDecide: (
    token: string,
    approved: boolean,
    reason?: string,
  ): Promise<AiApprovalToken> =>
    ipcRenderer.invoke('ai:approval:decide', { token, approved, reason }),
  aiApprovalListPending: (): Promise<AiApprovalToken[]> =>
    ipcRenderer.invoke('ai:approval:list-pending'),

  // 审计日志：只读列表（无 clear/append IPC）。过滤器 Zod 严格校验。
  aiAuditList: (filter?: AiAuditFilter): Promise<AiAuditEntry[]> =>
    ipcRenderer.invoke('ai:audit:list', filter),

  // 应用确认：渲染进程处理完 apply-request 事件后回 ack。
  // 必须携带 targetScope/contentHash/revision，主进程与待处理请求逐一比对；
  // 不匹配/未知/重复的 ack 被拒绝（IPC 抛错）。渲染进程无法伪造执行。
  aiApplyAck: (ack: AiApplyAck): Promise<boolean> =>
    ipcRenderer.invoke('ai:apply:ack', ack),

  // ============ P4 MCP Client：窄 API，渲染进程永不 spawn/connect ============
  // 渲染进程只能：列出服务器/工具、添加 stdio/loopback 候选（存为 pending）、
  // 添加内置、构建确认、确认激活（nonce+指纹必须匹配主进程待处理项）、
  // enable/disable/reconnect/delete。无法 spawn/connect MCP、传 env、或为内置
  // 指定路径。无 raw stderr/instructions/tool payload 跨越到渲染进程。
  aiMcpList: (): Promise<AiMcpServerConfig[]> =>
    ipcRenderer.invoke('ai:mcp:list'),
  aiMcpListTools: (serverId: string): Promise<AiMcpToolMeta[]> =>
    ipcRenderer.invoke('ai:mcp:list-tools', serverId),
  aiMcpAddStdio: (input: { displayName: string; command: string; args: string[] }): Promise<AiMcpServerConfig> =>
    ipcRenderer.invoke('ai:mcp:add-stdio', input),
  aiMcpAddLoopback: (input: { displayName: string; url: string }): Promise<AiMcpServerConfig> =>
    ipcRenderer.invoke('ai:mcp:add-loopback', input),
  aiMcpAddBundled: (): Promise<AiMcpServerConfig> =>
    ipcRenderer.invoke('ai:mcp:add-bundled'),
  aiMcpBuildConfirmation: (serverId: string): Promise<AiMcpConfirmationRequest | null> =>
    ipcRenderer.invoke('ai:mcp:build-confirmation', serverId),
  aiMcpConfirm: (serverId: string, nonce: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:mcp:confirm', { serverId, nonce }),
  aiMcpEnable: (serverId: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('ai:mcp:enable', serverId),
  aiMcpDisable: (serverId: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('ai:mcp:disable', serverId),
  aiMcpReconnect: (serverId: string): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('ai:mcp:reconnect', serverId),
  aiMcpDelete: (serverId: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:mcp:delete', serverId),
  onMcpEvent: (cb: (event: AiMcpServerEvent) => void) => {
    const listener = (_e: unknown, event: AiMcpServerEvent) => cb(event)
    ipcRenderer.on('ai:mcp:event', listener)
    return () => ipcRenderer.removeListener('ai:mcp:event', listener)
  },

  // ============ Git Workbench（Task 1+2）：窄 API，渲染进程永不传 cwd/命令 ============
  // choose 返回用户选择的目录绝对路径（原生对话框），由渲染进程再调 open 校验。
  // open 返回 repositoryId（主进程分配的 opaque token），后续所有操作只传 id。
  gitChooseRepository: (): Promise<string | null> =>
    ipcRenderer.invoke('git:choose-repository'),
  gitOpenRepository: (absPath: string): Promise<GitRepositoryHandle> =>
    ipcRenderer.invoke('git:open-repository', absPath),
  gitListRecentRepositories: (): Promise<GitRecentRepository[]> =>
    ipcRenderer.invoke('git:list-recent-repositories'),
  gitRefreshStatus: (repositoryId: string): Promise<GitStatus> =>
    ipcRenderer.invoke('git:refresh-status', repositoryId),
  gitGetDiff: (req: GitDiffRequest): Promise<GitDiffResult> =>
    ipcRenderer.invoke('git:get-diff', req),
  // stage/unstage 执行后主进程直接返回刷新后的 status，避免渲染层再发一次请求。
  gitStageFiles: (repositoryId: string, paths: string[]): Promise<GitStatus> =>
    ipcRenderer.invoke('git:stage-files', repositoryId, paths),
  gitUnstageFiles: (repositoryId: string, paths: string[]): Promise<GitStatus> =>
    ipcRenderer.invoke('git:unstage-files', repositoryId, paths),
  gitListBranches: (repositoryId: string): Promise<GitBranchListResult> =>
    ipcRenderer.invoke('git:list-branches', repositoryId),
  gitSwitchBranch: (input: GitSwitchBranchInput): Promise<GitStatus> =>
    ipcRenderer.invoke('git:switch-branch', input),

  // ============ Git Workbench（Task 3）：commit / fetch / pull / push ============
  // 提交/拉取/推送都是独立用户动作；无 force push、无 reset --hard、无自动
  // commit+push 链路。commit 在主进程做身份/暂存/operation 前置校验。
  gitGetIdentity: (repositoryId: string): Promise<GitIdentity> =>
    ipcRenderer.invoke('git:get-identity', repositoryId),
  gitCommit: (input: GitCommitInput): Promise<GitCommitResult> =>
    ipcRenderer.invoke('git:commit', input),
  gitFetch: (repositoryId: string): Promise<GitSyncResult> =>
    ipcRenderer.invoke('git:fetch', repositoryId),
  gitPull: (repositoryId: string): Promise<GitSyncResult> =>
    ipcRenderer.invoke('git:pull', repositoryId),
  gitPush: (repositoryId: string): Promise<GitSyncResult> =>
    ipcRenderer.invoke('git:push', repositoryId),

  // ============ Git Workbench：首次推送 + 丢弃工作区改动 ============
  // push() 在无 upstream 时拒绝 NO_UPSTREAM，UI 引导用户从 listRemotes()
  // 返回的远端列表中明确选择一个，再调用 pushUpstream(remote)。绝不静默
  // 假设 origin。discardWorktreeFiles 仅作用于已跟踪未暂存改动，不触碰
  // 暂存区、不删除未跟踪文件；UI 必须先弹确认框逐文件提示不可撤销。
  gitListRemotes: (repositoryId: string): Promise<GitRemoteListResult> =>
    ipcRenderer.invoke('git:list-remotes', repositoryId),
  gitPushUpstream: (input: GitPushUpstreamInput): Promise<GitSyncResult> =>
    ipcRenderer.invoke('git:push-upstream', input),
  gitDiscardWorktreeFiles: (repositoryId: string, paths: string[]): Promise<GitStatus> =>
    ipcRenderer.invoke('git:discard-worktree-files', repositoryId, paths),

  // ============ Git Workbench：AI 生成提交说明 ============
  // 渲染层只传 repositoryId + modelProfileId，主进程经闭合 Git 服务收集
  // 「仅已暂存」的 diff（含 .env/.pem/密钥等路径排除 + 内容敏感度过滤 +
  // 80 KiB/12,000 行聚合上限），再调用现有 AI 平台的 Provider/Key 一次性
  // 生成。返回结构化 proposal（subject/body/rationale）+ 透明度元数据
  // （excludedPaths/cappedPaths/totalBytes/totalLines/truncated）。绝不自动
  // 暂存/提交/推送——渲染层把 subject/body 写入既有输入框供用户编辑。
  gitProposeCommitMessage: (req: GitCommitProposalRequest): Promise<GitCommitProposalResult> =>
    ipcRenderer.invoke('git:propose-commit-message', req),
}

contextBridge.exposeInMainWorld('raintool', api)
