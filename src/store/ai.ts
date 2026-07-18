// AI Assistant UI store (renderer-only state).
//
// Holds no API keys — only conversation summaries, the active conversation,
// profile list, credential *status* (masked), and the live run stream. The
// store subscribes to ai:run:event and appends streamed text to the active
// conversation's messages optimistically; persistence is the main process's
// job (it appends the final message on completion).

import { create } from 'zustand'
import type {
  AiConversation,
  AiConversationSummary,
  AiCredentialStatus,
  AiModelProfile,
  AiRunEvent,
  AiSupplier,
} from '../../electron/ai-platform/ai-types'
import type {
  AiAttachmentMeta,
  AiAttachmentSource,
} from '../../electron/ai-platform/ai-context-types'
import type { AiArtifactMeta } from '../../electron/ai-platform/ai-context-types'
import type {
  AiAuditEntry,
  AiApprovalToken,
  AiToolMeta,
} from '../../electron/ai-platform/ai-tool-types'
import type {
  AiMcpConfirmationRequest,
  AiMcpServerConfig,
  AiMcpServerEvent,
  AiMcpToolMeta,
} from '../../electron/ai-platform/ai-mcp-types'
import { eligibilityReason, shouldResetConfirmation } from '../../electron/ai-platform/ai-eligibility'

type RunStatus = 'idle' | 'streaming' | 'cancelling' | 'error'

const ACTIVE_PROFILE_STORAGE_KEY = 'raintool.ai.active-profile-id'

function readPersistedActiveProfileId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
  } catch {
    return null
  }
}

function persistActiveProfileId(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, id)
  } catch {
    // A disabled storage backend must not prevent model selection.
  }
}

/** A renderer-side view of a tool call's lifecycle (one card per toolCallId). */
interface ToolCallEntry {
  toolCallId: string
  toolId: string
  risk: string
  /** The fixed metadata summary (no raw input payload). */
  inputSummary: string
  status: 'proposed' | 'awaiting-approval' | 'started' | 'completed' | 'failed'
  summary?: string
  preview?: string
  /**
   * P3 propose→artifact: opaque artifact id when a propose tool persisted a
   * read-only proposal artifact. The UI links to the Artifacts drawer; the raw
   * content lives main-process (preview/copy only, NO apply/writeback).
   */
  artifactRef?: string
  redactedError?: string
  category?: string
  /** The approval token (present while awaiting-approval). */
  token?: string
  impactSummary?: string
  impactPreview?: string
  targetScope?: string
  contentHash?: string
}

interface AiState {
  conversations: AiConversationSummary[]
  activeConversation: AiConversation | null
  profiles: AiModelProfile[]
  /** credentialKey -> masked status. Renderer never holds raw keys. */
  credentialStatuses: Record<string, AiCredentialStatus>
  activeProfileId: string | null

  /** Live run state. */
  runStatus: RunStatus
  activeRunId: string | null
  /** Streamed text accumulator for the in-flight assistant message. */
  streamingText: string
  /** Last recoverable error shown to the user. */
  lastError: string | null
  /** Outbound privacy confirmation gate: user must confirm before first send. */
  privacyConfirmed: boolean

  /** P2: selected attachment chips for the next run (metadata only; no payload). */
  attachments: AiAttachmentMeta[]
  /** P2: read-only artifact proposals (metadata list for the sidebar). */
  artifacts: AiArtifactMeta[]
  /**
   * P2/P3: whether the Artifacts drawer is open. A propose tool's
   * ToolCallCard flips this when the user clicks "在 Artifacts 查看" so the
   * drawer surfaces the just-created read-only proposal without prop-drilling.
   */
  artifactsOpen: boolean

  /** P3: registered tool metadata (id/title/risk; no executor). */
  tools: AiToolMeta[]
  /** P3: tool-call lifecycle cards for the active run (keyed by toolCallId). */
  toolCalls: ToolCallEntry[]
  /** P3: pending approval tokens awaiting a user decision. */
  pendingApprovals: AiApprovalToken[]
  /** P3: read-only audit entries (newest first; no renderer clear). */
  auditEntries: AiAuditEntry[]

  /** P4: configured MCP servers (metadata + status; renderer never spawns/connects). */
  mcpServers: AiMcpServerConfig[]
  /** P4: discovered tools per server (inventory-only; not executable in P4). */
  mcpTools: Record<string, AiMcpToolMeta[]>
  /** P4: whether the MCP Servers drawer is open. */
  mcpOpen: boolean

  /** P0-1: suppliers (provider configs). The settings page edits these. */
  suppliers: AiSupplier[]
  /** P0-1: whether the full Model Settings page is open (replaces the old drawer). */
  modelSettingsOpen: boolean

  // hydration
  loadConversations: () => Promise<void>
  loadProfiles: () => Promise<void>
  /** P0-1: load suppliers (provider configs) from main. */
  loadSuppliers: () => Promise<void>
  /** P0-1: transactional supplier + credential save (no orphan on failure). */
  saveSupplier: (input: { supplier: import('../../electron/ai-platform/ai-types').AiSupplierInput; rawKey?: string }) => Promise<{ ok: boolean; reason?: string }>
  /** P0-1: toggle a supplier's enable flag (disabled supplier → its models excluded). */
  setSupplierEnabled: (id: string, enabled: boolean) => Promise<void>
  /** P0-1: delete a supplier. */
  deleteSupplier: (id: string) => Promise<void>
  /** P0-1: open/close the Model Settings page. */
  setModelSettingsOpen: (open: boolean) => void
  selectConversation: (id: string | null) => Promise<void>
  createConversation: (modelProfileId: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  setActiveProfile: (id: string) => void
  refreshCredentialStatus: (credentialKey: string) => Promise<void>
  setPrivacyConfirmed: (v: boolean) => void

  // P2 attachments (chips hold metadata; raw text lives main-process)
  ingestAttachment: (source: AiAttachmentSource, title: string, text: string) => Promise<void>
  removeAttachment: (id: string) => Promise<void>
  clearAttachments: () => Promise<void>

  // P2 artifacts (read-only proposals; preview/copy only, no apply/writeback)
  loadArtifacts: () => Promise<void>
  saveReplyAsArtifact: (kind: 'markdown' | 'json' | 'code', title: string, content: string) => Promise<void>
  /** P2/P3: open/close the Artifacts drawer (driven by the sidebar button or a propose-tool card). */
  setArtifactsOpen: (open: boolean) => void

  // P3 tools/audit
  loadTools: () => Promise<void>
  loadAudit: () => Promise<void>

  // P3 direct tool invocation + approval
  startToolRun: (toolCalls: { toolId: string; rawInput: unknown }[]) => Promise<void>
  decideApproval: (token: string, approved: boolean, reason?: string) => Promise<void>

  // P4 MCP servers (renderer never spawns/connects; main owns every connection)
  loadMcpServers: () => Promise<void>
  loadMcpTools: (serverId: string) => Promise<void>
  addMcpStdio: (input: { displayName: string; command: string; args: string[] }) => Promise<void>
  addMcpLoopback: (input: { displayName: string; url: string }) => Promise<void>
  addMcpBundled: () => Promise<void>
  buildMcpConfirmation: (serverId: string) => Promise<AiMcpConfirmationRequest | null>
  confirmMcp: (serverId: string, nonce: string) => Promise<void>
  enableMcp: (serverId: string) => Promise<void>
  disableMcp: (serverId: string) => Promise<void>
  reconnectMcp: (serverId: string) => Promise<void>
  deleteMcp: (serverId: string) => Promise<void>
  setMcpOpen: (open: boolean) => void
  bindMcpEvents: () => () => void

  // runs
  startRun: (message: string) => Promise<void>
  cancelRun: () => Promise<void>
  /** Wire an ai:run:event subscription; returns unsubscribe. */
  bindRunEvents: () => () => void
}

export const useAiStore = create<AiState>((set, get) => ({
  conversations: [],
  activeConversation: null,
  profiles: [],
  credentialStatuses: {},
  activeProfileId: null,
  runStatus: 'idle',
  activeRunId: null,
  streamingText: '',
  lastError: null,
  privacyConfirmed: false,
  attachments: [],
  artifacts: [],
  artifactsOpen: false,
  tools: [],
  toolCalls: [],
  pendingApprovals: [],
  auditEntries: [],
  mcpServers: [],
  mcpTools: {},
  mcpOpen: false,
  suppliers: [],
  modelSettingsOpen: false,

  loadConversations: async () => {
    const conversations = await window.raintool.aiListConversations()
    set({ conversations })
    // If the active conversation was deleted externally, clear it.
    const active = get().activeConversation
    if (active && !conversations.some((c) => c.id === active.id)) {
      set({ activeConversation: null })
    }
  },

  loadProfiles: async () => {
    // P0-1: load ONLY enabled profiles for the assistant dropdown. The full
    // list (including disabled) is shown in the Model Settings page, which
    // calls aiListProfiles directly. Disabled models/suppliers are excluded
    // here so the assistant can never pick one for a new run.
    const profiles = await window.raintool.aiListProfiles()
    const enabledProfiles = profiles.filter((p) => p.enabled !== false)
    // Capture the active profile as it was BEFORE the refresh, so an upsert
    // that changed the active profile's effective URL (same id, different
    // baseUrl) is detected and privacyConfirmed is reset — a confirmation to
    // one remote URL must not survive a redirect to a different remote URL.
    const prevActiveId = get().activeProfileId ?? readPersistedActiveProfileId()
    const prevActive = prevActiveId
      ? get().profiles.find((p) => p.id === prevActiveId) ?? null
      : null
    // If the previously-active profile got disabled, drop it so the dropdown
    // doesn't show a disabled model as selected.
    const activeProfileId = (prevActiveId && enabledProfiles.some((p) => p.id === prevActiveId))
      ? prevActiveId
      // TokenHub's AUTO route is substantially faster for interactive use
      // than pinning a large reasoning model, so prefer it only when the user
      // has not already made a persisted selection.
      : enabledProfiles.find((p) => p.model.toUpperCase() === 'AUTO')?.id
        ?? enabledProfiles[0]?.id
        ?? null
    const nextActive = activeProfileId
      ? enabledProfiles.find((p) => p.id === activeProfileId) ?? null
      : null
    const reset = shouldResetConfirmation(prevActive, nextActive)
    set({
      profiles: enabledProfiles,
      activeProfileId,
      ...(reset ? { privacyConfirmed: false } : {}),
    })
    if (activeProfileId) persistActiveProfileId(activeProfileId)
    // Hydrate credential statuses for all enabled profiles (masked only).
    const statuses: Record<string, AiCredentialStatus> = { ...get().credentialStatuses }
    await Promise.all(enabledProfiles.map(async (p) => {
      if (!statuses[p.credentialKey]) {
        statuses[p.credentialKey] = await window.raintool.aiCredentialStatus(p.credentialKey)
      }
    }))
    set({ credentialStatuses: statuses })
  },

  // P0-1: suppliers (provider configs).
  loadSuppliers: async () => {
    const suppliers = await window.raintool.aiListSuppliers()
    set({ suppliers })
  },

  saveSupplier: async (input) => {
    const result = await window.raintool.aiSaveSupplier(input)
    if (!result.ok) {
      set({ lastError: '本机加密不可用，凭据未保存，供应商未创建' })
      return { ok: false, reason: 'encryption-unavailable' }
    }
    // Refresh suppliers + profiles so the UI reflects the new/edited supplier
    // and its models. Also refresh the masked credential status.
    await get().loadSuppliers()
    await get().loadProfiles()
    await get().refreshCredentialStatus(result.supplier.credentialKey)
    return { ok: true }
  },

  setSupplierEnabled: async (id, enabled) => {
    try {
      await window.raintool.aiSetSupplierEnabled(id, enabled)
      await get().loadSuppliers()
      // Profiles depend on supplier enable state — reload so the dropdown
      // drops the newly-disabled supplier's models.
      await get().loadProfiles()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '切换供应商启用状态失败'
      set({ lastError: msg })
    }
  },

  deleteSupplier: async (id) => {
    try {
      await window.raintool.aiDeleteSupplier(id)
      await get().loadSuppliers()
      await get().loadProfiles()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '删除供应商失败'
      set({ lastError: msg })
    }
  },

  setModelSettingsOpen: (open) => set({ modelSettingsOpen: open }),

  selectConversation: async (id) => {
    if (!id) { set({ activeConversation: null }); return }
    const conversation = await window.raintool.aiGetConversation(id)
    set({ activeConversation: conversation, streamingText: '', lastError: null })
  },

  createConversation: async (modelProfileId) => {
    set({ lastError: null })
    try {
      const conversation = await window.raintool.aiCreateConversation({ modelProfileId })
      set({ activeConversation: conversation })
      await get().loadConversations()
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : '新建会话失败' })
    }
  },

  deleteConversation: async (id) => {
    await window.raintool.aiDeleteConversation(id)
    const active = get().activeConversation
    if (active?.id === id) set({ activeConversation: null })
    await get().loadConversations()
  },

  setActiveProfile: (id) => {
    const prev = get().profiles.find((p) => p.id === get().activeProfileId) ?? null
    const next = get().profiles.find((p) => p.id === id) ?? null
    // Confirmation is destination-bound (by effective URL, not profile id):
    // switching to a profile with a different effective URL resets
    // privacyConfirmed so a confirmation to one remote destination never
    // silently authorizes a different one. Loopback↔loopback keeps the flag
    // (neither needs it); same effective URL keeps it (even across different
    // profile ids pointed at the same endpoint).
    const reset = shouldResetConfirmation(prev, next)
    persistActiveProfileId(id)
    set({ activeProfileId: id, ...(reset ? { privacyConfirmed: false } : {}) })
  },

  refreshCredentialStatus: async (credentialKey) => {
    const status = await window.raintool.aiCredentialStatus(credentialKey)
    set((s) => ({ credentialStatuses: { ...s.credentialStatuses, [credentialKey]: status } }))
  },

  setPrivacyConfirmed: (v) => set({ privacyConfirmed: v }),

  // P2: attachment chips hold METADATA only. The raw text is ingested into the
  // main-process vault (never returned to the renderer); the chip stores the
  // returned AiAttachmentMeta so the UI can show bytes/tokens/sensitivity and
  // the runtime can resolve the payload by id on send.
  ingestAttachment: async (source, title, text) => {
    const meta = await window.raintool.aiContextIngest({ source, title, text })
    set((s) => ({ attachments: [...s.attachments, meta] }))
  },

  removeAttachment: async (id) => {
    await window.raintool.aiContextDelete(id)
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) }))
  },

  clearAttachments: async () => {
    // Delete every chip's payload from the main-process vault (not just the
    // local metadata) so the raw text is actually purged.
    const ids = get().attachments.map((a) => a.id)
    await Promise.all(ids.map((id) => window.raintool.aiContextDelete(id)))
    set({ attachments: [] })
  },

  // P2: artifacts are read-only proposals. loadArtifacts hydrates the sidebar
  // list (metadata only); saveReplyAsArtifact creates a new artifact from a
  // completed assistant reply. There is NO apply/writeback — preview/copy only.
  loadArtifacts: async () => {
    const artifacts = await window.raintool.aiArtifactList()
    set({ artifacts })
  },

  saveReplyAsArtifact: async (kind, title, content) => {
    await window.raintool.aiArtifactCreate({ kind, title, content })
    await get().loadArtifacts()
  },

  setArtifactsOpen: (open) => set({ artifactsOpen: open }),

  // P3: load registered tool metadata (no executor/schema crosses IPC).
  loadTools: async () => {
    const tools = await window.raintool.aiToolList()
    set({ tools })
  },

  // P3: load read-only audit entries (newest first; no renderer clear).
  loadAudit: async () => {
    const auditEntries = await window.raintool.aiAuditList({ limit: 200 })
    set({ auditEntries })
  },

  // P3: start a direct-tool run (no model stream; no profile/credential
  // required). The runtime resolves + Zod-validates each call, runs the tool
  // state machine, and emits tool/approval events. This is the explicit,
  // audited, renderer-initiated path — NOT model tool calling.
  startToolRun: async (toolCalls) => {
    const active = get().activeConversation
    if (!active) return
    set({
      runStatus: 'streaming', streamingText: '', lastError: null,
      toolCalls: [], pendingApprovals: [],
    })
    try {
      const { runId } = await window.raintool.aiStartRun({
        conversationId: active.id,
        modelProfileId: get().activeProfileId ?? '',
        mode: 'chat',
        message: '',
        toolCalls,
      })
      set({ activeRunId: runId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '启动工具运行失败'
      set({ runStatus: 'error', lastError: msg, activeRunId: null })
    }
  },

  // P3: approve/reject a pending write-tool approval. Reject requires a
  // non-empty reason (the main process enforces this; the UI also gates the
  // button). The decision flows to the runtime's poller via the approval
  // manager, which then consumes + executes (or fails) the tool.
  decideApproval: async (token, approved, reason) => {
    try {
      await window.raintool.aiApprovalDecide(token, approved, reason)
      // Refresh the pending list so the UI reflects the decision.
      const pending = await window.raintool.aiApprovalListPending()
      set({ pendingApprovals: pending })
    } catch (err) {
      // A reject with no/empty/restricted reason is rejected by the main
      // process. Surface the safe error.
      const msg = err instanceof Error ? err.message : '审批操作失败'
      set({ lastError: msg })
    }
  },

  // ---- P4 MCP servers ----
  // The renderer NEVER spawns/connects MCP. These actions call the narrow
  // guarded IPC; main owns every connection. No raw stderr/instructions/tool
  // payload crosses to the store — only safe metadata + status.
  loadMcpServers: async () => {
    const mcpServers = await window.raintool.aiMcpList()
    set({ mcpServers })
  },
  loadMcpTools: async (serverId) => {
    const tools = await window.raintool.aiMcpListTools(serverId)
    set((s) => ({ mcpTools: { ...s.mcpTools, [serverId]: tools } }))
  },
  addMcpStdio: async (input) => {
    await window.raintool.aiMcpAddStdio(input)
    await get().loadMcpServers()
  },
  addMcpLoopback: async (input) => {
    await window.raintool.aiMcpAddLoopback(input)
    await get().loadMcpServers()
  },
  addMcpBundled: async () => {
    await window.raintool.aiMcpAddBundled()
    await get().loadMcpServers()
  },
  buildMcpConfirmation: async (serverId) => {
    return window.raintool.aiMcpBuildConfirmation(serverId)
  },
  confirmMcp: async (serverId, nonce) => {
    try {
      await window.raintool.aiMcpConfirm(serverId, nonce)
      await get().loadMcpServers()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'MCP 激活确认失败'
      set({ lastError: msg })
    }
  },
  enableMcp: async (serverId) => {
    const res = await window.raintool.aiMcpEnable(serverId)
    if (!res.ok) set({ lastError: res.reason })
    await get().loadMcpServers()
    if (res.ok) void get().loadMcpTools(serverId)
  },
  disableMcp: async (serverId) => {
    const res = await window.raintool.aiMcpDisable(serverId)
    if (!res.ok) set({ lastError: res.reason })
    await get().loadMcpServers()
  },
  reconnectMcp: async (serverId) => {
    const res = await window.raintool.aiMcpReconnect(serverId)
    if (!res.ok) set({ lastError: res.reason })
    await get().loadMcpServers()
    if (res.ok) void get().loadMcpTools(serverId)
  },
  deleteMcp: async (serverId) => {
    await window.raintool.aiMcpDelete(serverId)
    await get().loadMcpServers()
  },
  setMcpOpen: (open) => set({ mcpOpen: open }),
  bindMcpEvents: () => {
    return window.raintool.onMcpEvent((event: AiMcpServerEvent) => {
      // Refresh the server list so the UI reflects status/toolCount changes.
      void get().loadMcpServers()
      if (event.status === 'connected') void get().loadMcpTools(event.serverId)
    })
  },

  startRun: async (message) => {
    const active = get().activeConversation
    const profileId = get().activeProfileId
    const profile = get().profiles.find((p) => p.id === profileId) ?? null
    // Defense-in-depth: the component already gates the Send button + Enter on
    // the same helper, but re-check here so a store caller (devtools, a future
    // code path) cannot bypass the outbound-privacy gate. Loopback profiles are
    // exempt; anything remote requires privacyConfirmed. Never call IPC if
    // blocked — surface the reason via lastError instead.
    const eligibility = eligibilityReason({
      activeConversation: active ? { id: active.id } : null,
      activeProfile: profile,
      runStatus: get().runStatus,
      privacyConfirmed: get().privacyConfirmed,
      input: message,
      // P2: fail-closed on unavailable attachment chips — the runtime's vault
      // would reject the id, so block here instead of starting a run that
      // fails mid-flight. The renderer's Send button + Enter route through the
      // same gate; this is the defense-in-depth re-check.
      attachments: get().attachments,
    })
    if (!eligibility.ok) {
      set({ lastError: eligibility.message })
      return
    }
    if (!active || !profileId) return
    set({ runStatus: 'streaming', streamingText: '', lastError: null })
    // P2: pass the EXPLICIT selected attachment ids. Only these are sent — no
    // silent component context. The IPC boundary validates them before the run
    // starts; unknown/invalid ids throw synchronously.
    const attachmentIds = get().attachments.map((a) => a.id)
    try {
      const { runId } = await window.raintool.aiStartRun({
        conversationId: active.id,
        modelProfileId: profileId,
        mode: 'chat',
        message,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      })
      set({ activeRunId: runId })
    } catch (err) {
      // IPC rejection (e.g. unknown/expired attachment id, over-cap). Never
      // leave the UI stuck in "streaming" — restore to error with a safe
      // message. The raw error from the main process is already redacted.
      const msg = err instanceof Error ? err.message : '启动运行失败'
      set({ runStatus: 'error', lastError: msg, activeRunId: null, streamingText: '' })
    }
  },

  cancelRun: async () => {
    const runId = get().activeRunId
    if (!runId) return
    set({ runStatus: 'cancelling' })
    await window.raintool.aiCancelRun(runId)
  },

  bindRunEvents: () => {
    return window.raintool.onAiRunEvent((event: AiRunEvent) => {
      const state = get()
      // Ignore events from a run the renderer didn't start (another
      // conversation, a stale run, or a run superseded by a newer one).
      // `started` is matched against the active conversation id as well,
      // so a stream cannot corrupt the visible conversation.
      if (event.type === 'started') {
        if (event.payload.conversationId !== state.activeConversation?.id) return
        set({ activeRunId: event.runId, streamingText: '', runStatus: 'streaming' })
        return
      }
      if (event.runId !== state.activeRunId) return
      switch (event.type) {
        case 'text-delta':
          set((s) => ({ streamingText: s.streamingText + event.payload.delta }))
          break
        case 'completed':
          // Reload the conversation to pick up the persisted assistant message.
          // Clear attachment chips: the runtime cleared their payloads in
          // finishRun, so the local chip metadata is now stale.
          void get().selectConversation(get().activeConversation?.id ?? null)
          set({ runStatus: 'idle', activeRunId: null, streamingText: '', attachments: [] })
          void get().loadConversations()
          void get().loadAudit()
          break
        case 'failed':
          set({
            runStatus: 'error',
            lastError: event.payload.redactedError,
            activeRunId: null,
            streamingText: '',
            attachments: [],
          })
          void get().selectConversation(get().activeConversation?.id ?? null)
          void get().loadAudit()
          break
        case 'cancelled':
          set({ runStatus: 'idle', activeRunId: null, streamingText: '', attachments: [], pendingApprovals: [] })
          void get().selectConversation(get().activeConversation?.id ?? null)
          void get().loadAudit()
          break

        // ---- P3 tool + approval + apply events ----
        case 'tool-call-proposed': {
          const p = event.payload
          set((s) => ({
            toolCalls: [...s.toolCalls, {
              toolCallId: p.toolCallId, toolId: p.toolId, risk: p.risk,
              inputSummary: p.inputSummary, status: 'proposed',
            }],
          }))
          break
        }
        case 'approval-required': {
          const p = event.payload
          // Record the pending approval so the ApprovalCard can render. The
          // card's Approve/Reject buttons call decideApproval(token, ...).
          set((s) => ({
            toolCalls: s.toolCalls.map((tc) =>
              tc.toolCallId === p.toolCallId
                ? { ...tc, status: 'awaiting-approval' as const, token: p.token,
                    impactSummary: p.impactSummary, impactPreview: p.impactPreview,
                    targetScope: p.targetScope, contentHash: p.contentHash }
                : tc,
            ),
            pendingApprovals: [...s.pendingApprovals.filter((a) => a.token !== p.token), {
              token: p.token,
              request: {
                runId: event.runId, toolCallId: p.toolCallId, toolId: p.toolId,
                risk: p.risk, normalizedInput: '', targetScope: p.targetScope,
                contentHash: p.contentHash, revision: '',
                impactSummary: p.impactSummary, impactPreview: p.impactPreview,
              },
              status: 'pending' as const,
              createdAt: Date.now(), expiresAt: p.expiresAt,
            }],
          }))
          break
        }
        case 'approval-resolved': {
          const p = event.payload
          set((s) => ({
            pendingApprovals: s.pendingApprovals.filter((a) => a.token !== p.token),
          }))
          break
        }
        case 'tool-started': {
          const p = event.payload
          set((s) => ({
            toolCalls: s.toolCalls.map((tc) =>
              tc.toolCallId === p.toolCallId ? { ...tc, status: 'started' as const } : tc,
            ),
          }))
          break
        }
        case 'tool-completed': {
          const p = event.payload
          set((s) => ({
            toolCalls: s.toolCalls.map((tc) =>
              tc.toolCallId === p.toolCallId
                ? { ...tc, status: 'completed' as const, summary: p.summary, preview: p.preview, artifactRef: p.artifactRef }
                : tc,
            ),
          }))
          // A propose tool may have created a read-only artifact; refresh the
          // sidebar list so the new artifact is visible immediately.
          if (p.artifactRef) void get().loadArtifacts()
          break
        }
        case 'tool-failed': {
          const p = event.payload
          set((s) => ({
            toolCalls: s.toolCalls.map((tc) =>
              tc.toolCallId === p.toolCallId
                ? { ...tc, status: 'failed' as const, redactedError: p.redactedError, category: p.category }
                : tc,
            ),
          }))
          break
        }
        case 'apply-request': {
          // The JSON Workbench component handles this via its own subscription
          // (it owns the editor input + revision). The store does NOT apply
          // directly — there is no generic setter. The workbench verifies its
          // current editor revision matches, then acks via aiApplyAck. This
          // case is a no-op in the store; the workbench's onAiRunEvent
          // listener (registered in the component) does the apply + ack.
          break
        }
      }
    })
  },
}))
