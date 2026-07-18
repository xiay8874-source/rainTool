// AI Platform IPC handlers.
//
// Every renderer→main handler is guarded by assertTrustedRenderer (the same
// boundary the diagram IPC uses). The exposed surface is intentionally narrow:
//   - conversation list/get/create/delete/setTitle
//   - profile list/create/delete
//   - credential status (masked) / save / delete  — raw key NEVER returned
//   - run start (returns runId immediately) / cancel  — events on ai:run:event
//
// The renderer never sees: raw API keys, file paths beyond an opaque id, the
// vault ciphertext, or unredacted provider errors.
//
// ai:run:start returns the actual runId synchronously (the runtime allocates
// the run and detaches the stream), so the renderer can cancel the correct
// run. Terminal events flow later on `ai:run:event`.

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { P1_SUPPORTED_RUN_MODES, type AiRunMode } from './ai-types.js'
import type {
  AiConversation,
  AiConversationSummary,
  AiCredentialStatus,
  AiModelProfile,
  AiRunEvent,
  AiSaveCredentialResult,
} from './ai-types.js'
import type { AiConversationRepository } from './ai-conversation-repository.js'
import type { AiModelProfileRepository } from './ai-model-profile-repository.js'
import type { AiProfileInput } from './ai-types.js'
import type { AiCredentialVault } from './ai-credential-vault.js'
import { newCredentialKey } from './ai-credential-vault.js'
import type { AiRuntime } from './ai-runtime.js'
import type { AiContextVault } from './ai-context-vault.js'
import type { AiArtifactRepository } from './ai-artifact-repository.js'
import type { AiToolRegistry } from './ai-tool-registry.js'
import type { AiApprovalManager } from './ai-approval-manager.js'
import type { AiAuditLog } from './ai-audit-log.js'
import type { AiDecideResult } from './ai-approval-manager.js'
import type { AiMcpManager } from './ai-mcp-manager.js'
import { z } from 'zod'
import {
  AI_CONTEXT_MAX_ATTACHMENTS_PER_RUN,
  type AiAttachmentInput,
  type AiAttachmentMeta,
  type AiArtifactDocument,
  type AiArtifactInput,
  type AiArtifactJsonValidation,
  type AiArtifactMeta,
} from './ai-context-types.js'
import type {
  AiApplyAck,
  AiAuditFilter,
  AiToolMeta,
} from './ai-tool-types.js'

export interface AiIpcDeps {
  mainWindow: () => BrowserWindow | null
  assertTrustedRenderer: (event: IpcMainInvokeEvent | Electron.IpcMainEvent) => void
  conversationRepository: AiConversationRepository
  profileRepository: AiModelProfileRepository
  credentialVault: AiCredentialVault
  runtime: AiRuntime
  /** P2: context vault for attachment payloads. */
  contextVault: AiContextVault
  /** P2: read-only artifact repository. */
  artifactRepository: AiArtifactRepository
  /** P3: tool registry (allowlisted + Zod-validated). */
  toolRegistry: AiToolRegistry
  /** P3: approval manager (single-use TTL write tokens). */
  approvalManager: AiApprovalManager
  /** P3: audit log (append-only, safe metadata; renderer read-only). */
  auditLog: AiAuditLog
  /** P4: MCP client manager (main-owned connections; renderer never spawns). */
  mcpManager: AiMcpManager
}

/**
 * Register all AI IPC handlers. The runtime owns event emission (it has the
 * emit callback wired to mainWindow in the bootstrap); this module only wires
 * request/response handlers. No duplicate emit or provider-registry field
 * here — those live in the bootstrap/runtime.
 */
export function registerAiIpc(deps: AiIpcDeps): void {
  // ---- Conversations ----
  ipcMain.handle('ai:conversation:list', (event) => {
    deps.assertTrustedRenderer(event)
    return deps.conversationRepository.list() satisfies AiConversationSummary[]
  })

  ipcMain.handle('ai:conversation:get', (event, id: string) => {
    deps.assertTrustedRenderer(event)
    return deps.conversationRepository.get(id) satisfies AiConversation | null
  })

  ipcMain.handle('ai:conversation:create', (event, input: { title?: string; modelProfileId: string; mode?: AiRunMode }) => {
    deps.assertTrustedRenderer(event)
    // Enforce P1-supported run modes at the IPC boundary: P1 implements chat
    // only. Reject non-chat modes with an explicit safe error before persisting
    // a conversation the runtime would refuse to run.
    const mode: AiRunMode = input.mode ?? 'chat'
    if (!P1_SUPPORTED_RUN_MODES.has(mode)) {
      throw new Error(`P1 暂不支持该运行模式：${mode}（仅 chat）`)
    }
    return deps.conversationRepository.create({ ...input, mode }) satisfies AiConversation
  })

  ipcMain.handle('ai:conversation:delete', (event, id: string) => {
    deps.assertTrustedRenderer(event)
    return deps.conversationRepository.delete(id)
  })

  ipcMain.handle('ai:conversation:set-title', (event, id: string, title: string) => {
    deps.assertTrustedRenderer(event)
    return deps.conversationRepository.setTitle(id, title) satisfies AiConversation | null
  })

  // ---- Profiles (no key field on AiModelProfile) ----
  ipcMain.handle('ai:profile:list', (event) => {
    deps.assertTrustedRenderer(event)
    return deps.profileRepository.list() satisfies AiModelProfile[]
  })

  ipcMain.handle('ai:profile:create', (event, input: AiProfileInput) => {
    deps.assertTrustedRenderer(event)
    return deps.profileRepository.upsert(input) satisfies AiModelProfile
  })

  ipcMain.handle('ai:profile:delete', (event, id: string) => {
    deps.assertTrustedRenderer(event)
    return deps.profileRepository.delete(id)
  })

  // ---- Credentials (raw key never returned) ----
  ipcMain.handle('ai:credential:status', (event, credentialKey: string) => {
    deps.assertTrustedRenderer(event)
    return deps.credentialVault.status(credentialKey) satisfies AiCredentialStatus
  })

  ipcMain.handle('ai:credential:save', (event, credentialKey: string, rawKey: string) => {
    deps.assertTrustedRenderer(event)
    const result = deps.credentialVault.set(credentialKey, rawKey)
    if (!result.ok) {
      return { ok: false, reason: 'encryption-unavailable' } satisfies AiSaveCredentialResult
    }
    return {
      ok: true,
      status: deps.credentialVault.status(credentialKey),
    } satisfies AiSaveCredentialResult
  })

  ipcMain.handle('ai:credential:delete', (event, credentialKey: string) => {
    deps.assertTrustedRenderer(event)
    deps.credentialVault.delete(credentialKey)
    return deps.credentialVault.status(credentialKey)
  })

  /** Allocate a fresh credential key (renderer then saves the key into it). */
  ipcMain.handle('ai:credential:new-key', (event) => {
    deps.assertTrustedRenderer(event)
    return newCredentialKey()
  })

  // ---- Runs ----
  // start() is synchronous in the runtime: it allocates the run, emits
  // `started`, detaches the stream, and returns the runId immediately. The
  // renderer records this runId and uses it to cancel; it also ignores
  // ai:run:event whose runId does not match.
  ipcMain.handle('ai:run:start', (event, request) => {
    deps.assertTrustedRenderer(event)
    // Defensive P1 mode check at the IPC boundary. The runtime also rejects
    // non-chat modes with a deferred failed terminal; this synchronous check
    // refuses the request before allocating a runId for an unsupported mode.
    if (!P1_SUPPORTED_RUN_MODES.has(request.mode)) {
      throw new Error(`P1 暂不支持该运行模式：${request.mode}（仅 chat）`)
    }
    // P2: validate explicit attachment ids at the IPC boundary. Reject
    // invalid/unknown/oversize ids BEFORE allocating a run — the renderer gets
    // a synchronous error and no run starts. Only the explicitly listed ids
    // are passed to the runtime; no silent component context.
    const attachmentIds: string[] = Array.isArray(request.attachmentIds) ? request.attachmentIds : []
    if (attachmentIds.length > AI_CONTEXT_MAX_ATTACHMENTS_PER_RUN) {
      throw new Error(`附件数量超过上限（${AI_CONTEXT_MAX_ATTACHMENTS_PER_RUN}）`)
    }
    if (attachmentIds.length > 0) {
      const validation = deps.contextVault.validateIds(attachmentIds)
      if (!validation.ok) {
        throw new Error(validation.reason)
      }
    }
    // P3: validate toolCalls shape (Zod) at the IPC boundary. Each call must
    // be { toolId: string, rawInput: unknown }. The runtime resolves + Zod-
    // validates the rawInput against the tool's own schema. toolCalls is
    // optional — absent/empty means a normal chat run.
    if (request.toolCalls !== undefined && request.toolCalls !== null) {
      const toolCallsSchema = z.array(z.object({
        toolId: z.string().min(1).max(128),
        rawInput: z.unknown(),
      }).strict()).max(8)
      const parsed = toolCallsSchema.safeParse(request.toolCalls)
      if (!parsed.success) {
        throw new Error(`toolCalls 校验失败：${parsed.error.issues[0]?.message ?? 'invalid'}`)
      }
      request.toolCalls = parsed.data
    }
    const { runId } = deps.runtime.start(request)
    return { runId, accepted: true }
  })

  ipcMain.handle('ai:run:cancel', (event, runId: string) => {
    deps.assertTrustedRenderer(event)
    return deps.runtime.cancel(runId, 'user')
  })

  // ---- P2 Context Vault (attachment payload sent once via ingest, never returned/logged/persisted) ----
  // The raw attachment text crosses the trusted renderer→main boundary ONCE,
  // through ai:context:ingest. After that it is NEVER returned to the renderer,
  // NEVER logged, and NEVER persisted to disk. The renderer only ever sees
  // AiAttachmentMeta (id, title, size, tokens, sensitivity, storage, expiry,
  // payloadAvailable). The raw payload stays main-process and is released to
  // the provider only for the active run after budget + sensitivity gating.
  ipcMain.handle('ai:context:ingest', (event, input: AiAttachmentInput) => {
    deps.assertTrustedRenderer(event)
    return deps.contextVault.ingest(input) satisfies AiAttachmentMeta
  })

  ipcMain.handle('ai:context:list', (event) => {
    deps.assertTrustedRenderer(event)
    return deps.contextVault.list() satisfies AiAttachmentMeta[]
  })

  ipcMain.handle('ai:context:delete', (event, id: string) => {
    deps.assertTrustedRenderer(event)
    return deps.contextVault.delete(id)
  })

  ipcMain.handle('ai:context:clear-all', (event) => {
    deps.assertTrustedRenderer(event)
    deps.contextVault.clearAll()
    return true
  })

  // ---- P2 Artifacts (read-only proposals; NO apply/writeback) ----
  ipcMain.handle('ai:artifact:list', (event) => {
    deps.assertTrustedRenderer(event)
    return deps.artifactRepository.list() satisfies AiArtifactMeta[]
  })

  ipcMain.handle('ai:artifact:get', (event, id: string) => {
    deps.assertTrustedRenderer(event)
    return deps.artifactRepository.get(id) satisfies AiArtifactDocument | null
  })

  ipcMain.handle('ai:artifact:create', (event, input: AiArtifactInput) => {
    deps.assertTrustedRenderer(event)
    return deps.artifactRepository.create(input) satisfies AiArtifactDocument
  })

  // NOTE: there is NO ai:artifact:update handler. Artifacts are read-only
  // proposals exposed to the renderer — preview/copy only, no content-edit
  // path. The repository's internal update() exists for main-process use
  // (e.g. appending a revision when saving a new assistant reply) but is not
  // exposed to the renderer.

  ipcMain.handle('ai:artifact:delete', (event, id: string) => {
    deps.assertTrustedRenderer(event)
    return deps.artifactRepository.delete(id)
  })

  ipcMain.handle('ai:artifact:validate-json', (event, content: string) => {
    deps.assertTrustedRenderer(event)
    return deps.artifactRepository.validateJson(content) satisfies AiArtifactJsonValidation
  })

  // ---- P3 Tool Registry (read-only metadata; no executor exposure) ----
  ipcMain.handle('ai:tool:list', (event) => {
    deps.assertTrustedRenderer(event)
    return deps.toolRegistry.list() satisfies AiToolMeta[]
  })

  // ---- P3 Approval Manager (the ONLY approve path; reject requires reason) ----
  // decide() is the sole way to approve a write tool. It is guarded by
  // assertTrustedRenderer and validates: reject requires a non-empty reason;
  // the reason is sanitized (restricted content rejected). The renderer CANNOT
  // call consume() — that is runtime-internal. No keyboard-shortcut/hidden
  // approve: the IPC is the only path.
  const decideSchema = z.object({
    token: z.string().min(1).max(128),
    approved: z.boolean(),
    reason: z.string().max(2000).optional(),
  }).strict()
  ipcMain.handle('ai:approval:decide', (event, input: unknown) => {
    deps.assertTrustedRenderer(event)
    const parsed = decideSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error(`审批参数校验失败：${parsed.error.issues[0]?.message ?? 'invalid'}`)
    }
    const result: AiDecideResult = deps.approvalManager.decide(
      parsed.data.token,
      parsed.data.approved,
      parsed.data.reason,
    )
    if (!result.ok) {
      throw new Error(result.reason)
    }
    return result.token
  })

  ipcMain.handle('ai:approval:list-pending', (event) => {
    deps.assertTrustedRenderer(event)
    return deps.approvalManager.listPending()
  })

  // ---- P3 Audit Log (renderer READ-ONLY; no clear/append IPC) ----
  // The audit log is append-only from the main process and read-only from the
  // renderer. There is NO ai:audit:clear and NO ai:audit:append — the
  // renderer cannot fabricate audit entries or wipe the log. The filter is
  // Zod-validated (strict) so the renderer cannot inject arbitrary fields.
  const auditFilterSchema = z.object({
    runId: z.string().max(128).optional(),
    toolId: z.string().max(128).optional(),
    kind: z.enum([
      'tool-proposed', 'tool-approved', 'tool-rejected', 'tool-expired',
      'tool-cancelled', 'tool-started', 'tool-completed', 'tool-failed',
      'run-completed', 'run-failed', 'run-cancelled',
    ]).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }).strict().optional()
  ipcMain.handle('ai:audit:list', (event, filter?: unknown) => {
    deps.assertTrustedRenderer(event)
    let validatedFilter: AiAuditFilter | undefined
    if (filter !== undefined && filter !== null) {
      const parsed = auditFilterSchema.safeParse(filter)
      if (!parsed.success) {
        throw new Error(`审计过滤参数校验失败：${parsed.error.issues[0]?.message ?? 'invalid'}`)
      }
      validatedFilter = parsed.data
    }
    return deps.auditLog.list(validatedFilter)
  })

  // ---- P3 Apply Ack (guarded; tied to pending one-shot; no fabricated execution) ----
  // The renderer sends this AFTER handling an apply-request event. Main
  // resolves the pending one-shot by applyId (the runtime scans its own
  // internal pending maps — NO reflection, NO empty fan-out). Main ALSO
  // verifies the ack's targetScope/contentHash/revision match the stored
  // pending request exactly — a mismatched ack is rejected (renderer cannot
  // swap the target/content). `applied:false` with a reason means the renderer
  // refused (stale editor revision, component gone). The renderer CANNOT
  // fabricate tool execution — only an ack tied to the pending one-shot, with
  // matching scope/hash/revision, resolves it.
  const ackSchema = z.object({
    applyId: z.string().min(1).max(128),
    applied: z.boolean(),
    targetScope: z.string().min(1).max(128),
    contentHash: z.string().min(1).max(128),
    revision: z.string().min(1).max(128),
    reason: z.string().max(1000).optional(),
  }).strict()
  ipcMain.handle('ai:apply:ack', (event, input: unknown) => {
    deps.assertTrustedRenderer(event)
    const parsed = ackSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error(`应用确认参数校验失败：${parsed.error.issues[0]?.message ?? 'invalid'}`)
    }
    const ack: AiApplyAck = parsed.data
    // The runtime scans its own pending-apply maps by applyId. No runId is
    // needed (the applyId is a unique random id only main could have emitted).
    // handleApplyAck verifies scope/hash/revision against the stored pending
    // request and consumes the one-shot. A mismatched/unknown/duplicate ack
    // returns ok:false → the IPC call is REJECTED (throws). For a mismatch the
    // one-shot is still consumed + the tool failure resolves (so the run fails
    // cleanly), but the renderer never sees success for a bad ack.
    const result = deps.runtime.handleApplyAck(ack)
    if (!result.ok) {
      const label = result.reason === 'mismatch'
        ? '应用确认范围/哈希/版本不匹配'
        : result.reason === 'duplicate'
          ? '应用确认重复（一次性请求已消费）'
          : '应用确认不匹配任何待处理的应用请求（未知/过期）'
      throw new Error(label)
    }
    return true
  })

  // ---- P4 MCP Client (main-owned connections; renderer never spawns) ----
  // The renderer may: list servers/tools, add a user-stdio candidate (stored
  // disabled/pending), build a confirmation, confirm activation (nonce+fingerprint
  // must match a main-owned pending entry), add the bundled built-in (path
  // resolved by main), enable/disable/reconnect. It may NOT spawn/connect MCP,
  // pass env, or supply a launcher path for the built-in. No raw stderr/
  // instructions/tool-payload crosses to the renderer.
  const stdioCandidateSchema = z.object({
    displayName: z.string().min(1).max(200),
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(32),
  }).strict()
  const loopbackCandidateSchema = z.object({
    displayName: z.string().min(1).max(200),
    url: z.string().min(1).max(2048),
  }).strict()
  ipcMain.handle('ai:mcp:list', (event) => {
    deps.assertTrustedRenderer(event)
    return deps.mcpManager.listServers()
  })
  ipcMain.handle('ai:mcp:list-tools', (event, serverId: string) => {
    deps.assertTrustedRenderer(event)
    return deps.mcpManager.listTools(serverId)
  })
  ipcMain.handle('ai:mcp:add-stdio', (event, input: unknown) => {
    deps.assertTrustedRenderer(event)
    const parsed = stdioCandidateSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error(`MCP 候选参数校验失败：${parsed.error.issues[0]?.message ?? 'invalid'}`)
    }
    const result = deps.mcpManager.addUserStdioCandidate(parsed.data)
    if (!result.ok) throw new Error(result.reason)
    return result.server
  })
  ipcMain.handle('ai:mcp:add-loopback', (event, input: unknown) => {
    deps.assertTrustedRenderer(event)
    const parsed = loopbackCandidateSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error(`MCP loopback 候选参数校验失败：${parsed.error.issues[0]?.message ?? 'invalid'}`)
    }
    const result = deps.mcpManager.addLoopbackCandidate(parsed.data)
    if (!result.ok) throw new Error(result.reason)
    return result.server
  })
  ipcMain.handle('ai:mcp:add-bundled', (event) => {
    deps.assertTrustedRenderer(event)
    const result = deps.mcpManager.addBundledBuiltIn()
    if (!result.ok) throw new Error(result.reason)
    return result.server
  })
  ipcMain.handle('ai:mcp:build-confirmation', (event, serverId: string) => {
    deps.assertTrustedRenderer(event)
    return deps.mcpManager.buildConfirmation(serverId)
  })
  ipcMain.handle('ai:mcp:confirm', (event, input: unknown) => {
    deps.assertTrustedRenderer(event)
    const parsed = z.object({ serverId: z.string().min(1).max(128), nonce: z.string().min(1).max(128) }).strict().safeParse(input)
    if (!parsed.success) {
      throw new Error(`MCP 确认参数校验失败：${parsed.error.issues[0]?.message ?? 'invalid'}`)
    }
    const result = deps.mcpManager.confirmActivation(parsed.data.serverId, parsed.data.nonce)
    if (!result.ok) throw new Error(result.reason)
    return true
  })
  ipcMain.handle('ai:mcp:enable', (event, serverId: string) => {
    deps.assertTrustedRenderer(event)
    return deps.mcpManager.enable(serverId)
  })
  ipcMain.handle('ai:mcp:disable', (event, serverId: string) => {
    deps.assertTrustedRenderer(event)
    return deps.mcpManager.disable(serverId)
  })
  ipcMain.handle('ai:mcp:reconnect', (event, serverId: string) => {
    deps.assertTrustedRenderer(event)
    return deps.mcpManager.reconnect(serverId)
  })
  ipcMain.handle('ai:mcp:delete', (event, serverId: string) => {
    deps.assertTrustedRenderer(event)
    return deps.mcpManager.delete(serverId)
  })
}
