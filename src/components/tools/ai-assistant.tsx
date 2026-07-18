// AI Assistant tool (P1).
//
// Minimal, accessible standalone UI. Coexists with existing tabs — does not
// rewrite AI Draw.io, diagram management, or the diagram MCP. No tool calling,
// no MCP, no Agent loop, no Git, no filesystem, no subagents, no provider key
// in the UI (only masked credential status).
//
// Layout: conversation sidebar | messages | composer, with a settings drawer
// for model profiles + credentials. Outbound privacy confirmation gates the
// first send per session — enforced via the shared `eligibilityReason` helper
// (button + Enter both route through it). Loopback profiles (Ollama default,
// or any Base URL on 127.0.0.1/localhost/::1) are exempt: they never leave
// this machine, so no confirmation banner or block. A profile whose effective
// URL is remote (including an Ollama profile pointed at a remote host via
// baseUrl override) requires confirmation before the first send.

import { useEffect, useRef, useState } from 'react'
import { useAiStore } from '@/store/ai'
import { ModelSettings } from '@/components/settings/ModelSettings'
import type { AiModelProfile, AiProviderId } from '../../../electron/ai-platform/ai-types'
import type { AiAttachmentMeta } from '../../../electron/ai-platform/ai-context-types'
import { AI_CONTEXT_BUDGET_TOKENS, AI_CONTEXT_MAX_ATTACHMENTS_PER_RUN } from '../../../electron/ai-platform/ai-context-types'
import { canStartRun, eligibilityReason, isOutboundLocal } from '../../../electron/ai-platform/ai-eligibility'
import type { ToolProps } from './shared'

const PROVIDER_LABELS: Record<AiProviderId, string> = {
  'openai-compatible': 'OpenAI 兼容',
  ollama: 'Ollama (本地)',
  anthropic: 'Anthropic',
  google: 'Google',
}

export default function AiAssistant(_props: ToolProps) {
  const store = useAiStore()
  // Zustand's whole-state object changes on every set(). Depending on it in
  // the hydration effect caused every keystroke/state update to re-run all
  // IPC loads and rebind event listeners. In particular, createConversation
  // could set the new conversation active and then lose it to a stale reload.
  // Actions are stable for the lifetime of the store, so depend on those
  // references only.
  const loadConversations = useAiStore((s) => s.loadConversations)
  const loadProfiles = useAiStore((s) => s.loadProfiles)
  const loadSuppliers = useAiStore((s) => s.loadSuppliers)
  const loadArtifacts = useAiStore((s) => s.loadArtifacts)
  const loadMcpServers = useAiStore((s) => s.loadMcpServers)
  const bindRunEvents = useAiStore((s) => s.bindRunEvents)
  const bindMcpEvents = useAiStore((s) => s.bindMcpEvents)
  const [input, setInput] = useState('')
  const [waitingSeconds, setWaitingSeconds] = useState(0)
  const messagesRef = useRef<HTMLDivElement>(null)

  // Hydrate on mount + bind the run event stream.
  useEffect(() => {
    void loadConversations()
    void loadProfiles()
    void loadSuppliers()
    void loadArtifacts()
    void loadMcpServers()
    const unbind = bindRunEvents()
    const unbindMcp = bindMcpEvents()
    return () => { unbind(); unbindMcp() }
  }, [
    bindMcpEvents,
    bindRunEvents,
    loadArtifacts,
    loadConversations,
    loadMcpServers,
    loadProfiles,
    loadSuppliers,
  ])

  // Autoscroll messages to bottom on new content.
  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight })
  }, [store.activeConversation?.messages.length, store.streamingText])

  // Make first-token latency visible. A slow upstream should not look like a
  // frozen composer, and after eight seconds the UI offers the faster AUTO
  // route as an actionable alternative.
  useEffect(() => {
    if (store.runStatus !== 'streaming') {
      setWaitingSeconds(0)
      return
    }
    const startedAt = Date.now()
    setWaitingSeconds(0)
    const timer = window.setInterval(() => {
      setWaitingSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [store.activeRunId, store.runStatus])

  const activeProfile = store.profiles.find((p) => p.id === store.activeProfileId) ?? null
  // Enforceable outbound-privacy gate: a run may start only when the shared
  // eligibility helper says so. The helper exempts loopback profiles (local
  // Ollama / local LM Studio) from confirmation, but requires confirmation for
  // any profile whose effective base URL leaves this machine — including an
  // Ollama profile pointed at a remote host via baseUrl override. The button
  // AND the Enter key both route through `canSend`, so neither can bypass the
  // visible "需确认出网" notice.
  const eligibility = eligibilityReason({
    activeConversation: store.activeConversation ? { id: store.activeConversation.id } : null,
    activeProfile,
    runStatus: store.runStatus,
    privacyConfirmed: store.privacyConfirmed,
    input,
    // P2: fail-closed on unavailable attachment chips. A chip whose payload was
    // lost (payloadAvailable:false, e.g. after a restart) cannot be sent — the
    // runtime's vault would reject the id. The gate blocks Send + Enter here so
    // the run never starts with an id that would fail mid-flight. No silent
    // ignore: the block reason tells the user to remove or re-attach.
    attachments: store.attachments,
  })
  const canSend = eligibility.ok
  const blockReason = !eligibility.ok ? eligibility.message : null

  const handleSend = async () => {
    // Defense-in-depth: the store.startRun re-checks too, but the UI guard
    // keeps the button disabled and Enter inert when blocked.
    if (!canStartRun({
      activeConversation: store.activeConversation ? { id: store.activeConversation.id } : null,
      activeProfile,
      runStatus: store.runStatus,
      privacyConfirmed: store.privacyConfirmed,
      input,
      attachments: store.attachments,
    })) return
    const message = input.trim()
    setInput('')
    await store.startRun(message)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Enter respects the same gate as the Send button — no run before
      // confirmation (or for loopback profiles, which are exempt).
      if (canSend) void handleSend()
    }
  }

  return (
    <div className="flex h-full">
      {/* Conversation sidebar */}
      <aside className="flex w-60 flex-col border-r border-line bg-bg-surface" aria-label="会话列表">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-label text-ink-tertiary">会话</span>
          <button
            onClick={() => activeProfile && store.createConversation(activeProfile.id)}
            disabled={!activeProfile}
            className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover disabled:opacity-40"
            aria-label="新建会话"
          >
            + 新建
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {store.conversations.length === 0 && (
            <div className="px-3 py-4 text-caption text-ink-tertiary">暂无会话</div>
          )}
          {store.conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => store.selectConversation(c.id)}
              className={`block w-full truncate px-3 py-2 text-left text-body hover:bg-bg-hover ${
                store.activeConversation?.id === c.id ? 'bg-bg-subtle text-ink-primary' : 'text-ink-secondary'
              }`}
            >
              <div className="truncate">{c.title}</div>
              <div className="text-label text-ink-tertiary">{new Date(c.updatedAt).toLocaleString()}</div>
            </button>
          ))}
        </div>
        <button
          onClick={() => store.setModelSettingsOpen(true)}
          className="border-t border-line px-3 py-2 text-left text-caption text-ink-secondary hover:bg-bg-hover"
        >
          ⚙ 模型设置
        </button>
        <button
          onClick={() => { void store.loadArtifacts(); store.setArtifactsOpen(true) }}
          className="border-t border-line px-3 py-2 text-left text-caption text-ink-secondary hover:bg-bg-hover"
        >
          📄 Artifacts ({store.artifacts.length})
        </button>
        <button
          onClick={() => { void store.loadMcpServers(); store.setMcpOpen(true) }}
          className="border-t border-line px-3 py-2 text-left text-caption text-ink-secondary hover:bg-bg-hover"
        >
          🔌 MCP 服务器 ({store.mcpServers.length})
        </button>
      </aside>

      {/* Main conversation pane */}
      <div className="flex flex-1 flex-col">
        {/* Header: profile / mode / privacy gate */}
        <div className="flex items-center gap-2 border-b border-line bg-bg-surface px-4 py-2">
          <select
            value={store.activeProfileId ?? ''}
            onChange={(e) => store.setActiveProfile(e.target.value)}
            className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary outline-none focus:border-accent"
            aria-label="选择模型配置"
          >
            {store.profiles.length === 0 && <option value="">未配置模型</option>}
            {store.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} · {p.model}
              </option>
            ))}
          </select>
          <span className="text-label text-ink-tertiary">对话模式（无工具）</span>
          {activeProfile && !store.privacyConfirmed && !isOutboundLocal(activeProfile) && (
            <span className="ml-auto text-label text-ink-tertiary">首次发送前需确认出网</span>
          )}
          {activeProfile && isOutboundLocal(activeProfile) && (
            <span className="ml-auto text-label text-ink-tertiary">本地模型，不出网</span>
          )}
        </div>

        {/* Messages */}
        <div ref={messagesRef} className="flex-1 overflow-auto px-4 py-3" role="log" aria-live="polite">
          {!store.activeConversation && (
            <div className="mt-12 text-center text-caption text-ink-tertiary">
              选择左侧会话或点击「新建」开始对话
            </div>
          )}
          {store.activeConversation?.messages.map((m: { id: string; role: string; text: string }) => (
            <MessageBubble
              key={m.id}
              role={m.role}
              text={m.text}
              onSaveAsArtifact={
                m.role === 'assistant' && m.text
                  ? () => void store.saveReplyAsArtifact('markdown', 'AI 回复', m.text)
                  : undefined
              }
            />
          ))}
          {/* In-flight streamed text */}
          {store.runStatus === 'streaming' && store.streamingText && (
            <MessageBubble role="assistant" text={store.streamingText} streaming />
          )}
          {store.runStatus === 'streaming' && !store.streamingText && !store.toolCalls.length && (
            <div className="mb-3 text-caption text-ink-tertiary">
              模型思考中… {waitingSeconds}s
              {waitingSeconds >= 8 && (
                <span className="ml-2">首个 token 较慢；可停止后切换到 AUTO 模型。</span>
              )}
            </div>
          )}
          {/* P3: tool-call lifecycle cards + approval cards. These render
              during a direct-tool run (no model stream). Each card shows the
              tool id/risk, the fixed metadata summary (no raw input), and the
              tool's status (proposed → awaiting-approval → started →
              completed/failed). A write tool awaiting approval renders an
              ApprovalCard with impact/scope + Approve/Reject buttons. Reject
              requires a visible non-empty reason (the Reject button is disabled
              until the reason field is non-empty). No keyboard/hidden approve. */}
          {store.toolCalls.map((tc) => (
            <ToolCallCard key={tc.toolCallId} entry={tc} />
          ))}
          {store.lastError && (
            <div className="mb-3 rounded-card border border-line bg-bg-subtle px-3 py-2 text-caption text-danger">
              出错：{store.lastError}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-line bg-bg-surface p-3">
          {!store.privacyConfirmed && activeProfile && !isOutboundLocal(activeProfile) && (
            <PrivacyGate
              profile={activeProfile}
              onConfirm={() => store.setPrivacyConfirmed(true)}
            />
          )}
          {/* P2: attachment chips + budget bar. Each chip shows bytes/tokens
              and sensitivity. Restricted chips are marked and block send
              (the runtime rejects them fail-closed). The budget bar shows the
              total token estimate against the P2 cap. */}
          <AttachmentChips
            attachments={store.attachments}
            onRemove={(id) => void store.removeAttachment(id)}
          />
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={activeProfile ? '输入消息，Enter 发送，Shift+Enter 换行' : '请先在设置中配置模型'}
              disabled={!activeProfile}
              spellCheck={false}
              className="flex-1 resize-none rounded-card border border-line bg-bg-surface p-2 text-body text-ink-primary outline-none focus:border-accent disabled:opacity-50"
              rows={2}
              aria-label="消息输入框"
            />
            <div className="flex flex-col gap-1">
              {store.runStatus === 'streaming' ? (
                <button
                  onClick={() => store.cancelRun()}
                  className="rounded-btn border border-line px-3 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
                  aria-label="停止生成"
                >
                  停止
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  className="rounded-btn bg-accent px-3 py-1 text-caption text-white hover:opacity-90 disabled:opacity-40"
                  aria-label="发送"
                  aria-disabled={!canSend}
                  title={blockReason ?? undefined}
                >
                  发送
                </button>
              )}
              {/* Visible reason when Send is disabled, so the gate is
                  self-explanatory rather than a silently greyed button. */}
              {blockReason && store.runStatus !== 'streaming' && (
                <span className="text-label text-ink-tertiary">{blockReason}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {store.modelSettingsOpen && <ModelSettings onClose={() => store.setModelSettingsOpen(false)} />}
      {store.artifactsOpen && <ArtifactsDrawer onClose={() => store.setArtifactsOpen(false)} />}
      {store.mcpOpen && <McpServersDrawer onClose={() => store.setMcpOpen(false)} />}
    </div>
  )
}

function MessageBubble({
  role,
  text,
  streaming,
  onSaveAsArtifact,
}: {
  role: string
  text: string
  streaming?: boolean
  /** P2: when set (assistant messages with text), show a "save as artifact" action. */
  onSaveAsArtifact?: () => void
}) {
  const isUser = role === 'user'
  return (
    <div className={`mb-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-card px-3 py-2 text-body ${
          isUser
            ? 'bg-accent-bg text-ink-primary'
            : 'bg-bg-subtle text-ink-primary'
        }${streaming ? ' opacity-90' : ''}`}
      >
        {text || (streaming ? '…' : '')}
        {!isUser && onSaveAsArtifact && (
          <div className="mt-1 text-right">
            <button
              onClick={onSaveAsArtifact}
              className="text-label text-ink-tertiary hover:text-ink-primary"
              title="保存为 Artifact（只读提案）"
            >
              保存为 Artifact
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function PrivacyGate({ profile, onConfirm }: { profile: AiModelProfile; onConfirm: () => void }) {
  const providerLabel = PROVIDER_LABELS[profile.providerId] ?? profile.providerId
  return (
    <div className="mb-2 rounded-card border border-line bg-bg-subtle px-3 py-2 text-caption text-ink-secondary">
      <div className="mb-1 font-medium text-ink-primary">出网确认</div>
      发送消息将把你的对话内容发送到 <strong>{providerLabel}</strong>（模型 {profile.model}）。
      {' 请确认内容不含敏感信息。'}
      <div className="mt-1 text-ink-tertiary">
        本地模型（Ollama 默认地址、或 Base URL 指向 127.0.0.1/localhost/::1）不出网，无需确认。
      </div>
      <button
        onClick={onConfirm}
        className="ml-2 rounded-btn bg-accent px-2 py-0.5 text-caption text-white hover:opacity-90"
      >
        我已知晓，本次会话继续
      </button>
    </div>
  )
}

/**
 * P2 attachment chips + budget bar. Each chip shows the attachment title,
 * bytes, token estimate, and sensitivity. Restricted chips are marked with a
 * warning and a tooltip showing the restriction reason; they block the run
 * fail-closed at the runtime. The budget bar shows total selected tokens
 * against the P2 cap. Raw payload text is never shown here — only metadata.
 */
function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: AiAttachmentMeta[]
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null
  const totalTokens = attachments.reduce((sum, a) => sum + a.tokenEstimate, 0)
  const pct = Math.min(100, Math.round((totalTokens / AI_CONTEXT_BUDGET_TOKENS) * 100))
  const atCapacity = attachments.length >= AI_CONTEXT_MAX_ATTACHMENTS_PER_RUN
  // NOTE: do NOT show a "will be ignored" status here. An unavailable chip
  // (payloadAvailable:false) blocks the run fail-closed via eligibilityReason
  // (Send disabled + Enter inert) — it is never silently ignored. The per-chip
  // "已失效" label tells the user which chip to remove or re-attach.
  return (
    <div className="mb-2">
      <div className="mb-1 flex flex-wrap gap-1">
        {attachments.map((a) => {
          const unavailable = !a.payloadAvailable
          return (
            <span
              key={a.id}
              className={`inline-flex items-center gap-1 rounded-btn border px-2 py-0.5 text-caption ${
                a.sensitivity === 'restricted'
                  ? 'border-danger text-danger'
                  : unavailable
                    ? 'border-line text-ink-tertiary opacity-60 line-through'
                    : 'border-line text-ink-secondary'
              }`}
              title={
                unavailable
                  ? '内容已失效（重启后不可用），请重新附加；发送前需移除失效附件'
                  : a.restrictionReason ?? a.title
              }
            >
              <span className="max-w-[120px] truncate">{a.title}</span>
              {unavailable ? (
                <span className="text-ink-tertiary">已失效</span>
              ) : (
                <span className="text-ink-tertiary">{a.byteSize}B · {a.tokenEstimate}t</span>
              )}
              {a.sensitivity === 'restricted' && <span title={a.restrictionReason}>⚠</span>}
              <button
                onClick={() => onRemove(a.id)}
                className="text-ink-tertiary hover:text-danger"
                aria-label={`移除附件 ${a.title}`}
              >
                ✕
              </button>
            </span>
          )
        })}
      </div>
      <div className="flex items-center gap-2 text-label text-ink-tertiary">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-subtle">
          <div
            className={`h-full ${pct > 80 ? 'bg-danger' : 'bg-accent'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span>{totalTokens}/{AI_CONTEXT_BUDGET_TOKENS} tokens</span>
        {atCapacity && <span className="text-danger">已达附件上限</span>}
      </div>
    </div>
  )
}

/**
 * P2 Artifacts drawer — read-only proposals. Lists artifacts with safe preview
 * + copy. There is NO apply/writeback action: an artifact never alters editor
 * text, a file, or a conversation. The user may delete an artifact they own.
 */
function ArtifactsDrawer({ onClose }: { onClose: () => void }) {
  const store = useAiStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ content: string; kind: string; title: string } | null>(null)
  const [copyMsg, setCopyMsg] = useState(false)

  useEffect(() => {
    if (!selectedId) { setPreview(null); return }
    void window.raintool.aiArtifactGet(selectedId).then((doc) => {
      if (doc) setPreview({ content: doc.content, kind: doc.kind, title: doc.title })
      else setPreview(null)
    })
  }, [selectedId])

  const copy = async () => {
    if (!preview) return
    await navigator.clipboard.writeText(preview.content)
    setCopyMsg(true)
    setTimeout(() => setCopyMsg(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" role="dialog" aria-modal="true" aria-label="Artifacts">
      <div className="flex h-[80vh] w-[700px] overflow-hidden rounded-card bg-bg-surface shadow-float">
        {/* List */}
        <div className="flex w-60 flex-col border-r border-line">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-label text-ink-tertiary">Artifacts</span>
            <button onClick={onClose} className="text-caption text-ink-tertiary hover:text-ink-primary" aria-label="关闭">✕</button>
          </div>
          <div className="flex-1 overflow-auto">
            {store.artifacts.length === 0 && (
              <div className="px-3 py-4 text-caption text-ink-tertiary">暂无 artifact</div>
            )}
            {store.artifacts.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                className={`block w-full truncate px-3 py-2 text-left text-body hover:bg-bg-hover ${
                  selectedId === a.id ? 'bg-bg-subtle text-ink-primary' : 'text-ink-secondary'
                }`}
              >
                <div className="truncate">{a.title}</div>
                <div className="text-label text-ink-tertiary">
                  {a.kind} · v{a.revisionCount} · {new Date(a.updatedAt).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        </div>
        {/* Preview (read-only; copy only; NO apply/writeback) */}
        <div className="flex flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <span className="text-caption text-ink-secondary">{preview?.title ?? '选择左侧 artifact 预览'}</span>
            {preview && (
              <div className="flex gap-2">
                <button
                  onClick={copy}
                  className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover"
                >
                  {copyMsg ? '已复制' : '复制'}
                </button>
                <button
                  onClick={async () => {
                    if (selectedId) {
                      await window.raintool.aiArtifactDelete(selectedId)
                      setSelectedId(null)
                      await store.loadArtifacts()
                    }
                  }}
                  className="rounded-btn border border-line px-2 py-0.5 text-caption text-danger hover:bg-bg-hover"
                >
                  删除
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-auto p-4">
            {preview ? (
              <pre className="whitespace-pre-wrap text-body text-ink-primary">{preview.content}</pre>
            ) : (
              <div className="mt-12 text-center text-caption text-ink-tertiary">
                Artifacts 为只读提案，可预览/复制，不会修改编辑器或文件
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// P4: MCP Servers drawer (status/tools, add built-in/stdio/loopback, confirm
// activation, disconnect/reconnect). No raw stderr/instructions ever shown.
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  'trusted-built-in': '内置（可信）',
  'user-stdio': '用户 stdio',
  'user-loopback': '用户 loopback HTTP',
}

const MCP_STATUS_LABELS: Record<string, string> = {
  'pending-confirmation': '待确认',
  'disabled': '已停用',
  'connecting': '连接中',
  'connected': '已连接',
  'error': '错误',
  'disconnected': '已断开',
}

function McpServersDrawer({ onClose }: { onClose: () => void }) {
  const store = useAiStore()
  const [addMode, setAddMode] = useState<'none' | 'stdio' | 'loopback'>('none')
  const [displayName, setDisplayName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [url, setUrl] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState<{ serverId: string; nonce: string; command?: string; args?: string[]; url?: string; source: string; riskNotice: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const resetAdd = () => {
    setAddMode('none'); setDisplayName(''); setCommand(''); setArgsText(''); setUrl('')
  }

  const handleAddStdio = async () => {
    if (!displayName.trim() || !command.trim()) return
    setBusy(true)
    try {
      // Args: newline-separated in the UI → string array (empty lines dropped).
      const args = argsText.split('\n').map((a) => a.trim()).filter((a) => a.length > 0)
      await store.addMcpStdio({ displayName: displayName.trim(), command: command.trim(), args })
      resetAdd()
    } finally { setBusy(false) }
  }

  const handleAddLoopback = async () => {
    if (!displayName.trim() || !url.trim()) return
    setBusy(true)
    try {
      await store.addMcpLoopback({ displayName: displayName.trim(), url: url.trim() })
      resetAdd()
    } finally { setBusy(false) }
  }

  const handleBuildConfirm = async (serverId: string) => {
    const req = await store.buildMcpConfirmation(serverId)
    if (!req) return
    setPendingConfirm({
      serverId: req.serverId,
      nonce: req.nonce,
      command: req.command,
      args: req.args,
      url: req.url,
      source: req.source,
      riskNotice: req.riskNotice,
    })
  }

  const handleConfirm = async () => {
    if (!pendingConfirm) return
    setBusy(true)
    try {
      await store.confirmMcp(pendingConfirm.serverId, pendingConfirm.nonce)
      setPendingConfirm(null)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" role="dialog" aria-modal="true" aria-label="MCP 服务器">
      <div className="flex h-[80vh] w-[680px] overflow-hidden rounded-card bg-bg-surface shadow-float">
        <div className="flex flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-page text-ink-primary">MCP 服务器</span>
            <button onClick={onClose} className="text-caption text-ink-tertiary hover:text-ink-primary" aria-label="关闭">✕</button>
          </div>

          <div className="flex-1 overflow-auto p-4">
            {/* Add buttons */}
            <div className="mb-4 flex gap-2">
              <button
                onClick={() => store.addMcpBundled()}
                className="rounded-btn border border-line px-3 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
              >
                添加内置 RainTool MCP
              </button>
              <button
                onClick={() => { resetAdd(); setAddMode('stdio') }}
                className="rounded-btn border border-line px-3 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
              >
                添加 stdio 服务器
              </button>
              <button
                onClick={() => { resetAdd(); setAddMode('loopback') }}
                className="rounded-btn border border-line px-3 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
              >
                添加 loopback HTTP
              </button>
            </div>

            {/* Add form — stdio */}
            {addMode === 'stdio' && (
              <div className="mb-4 rounded-card border border-line bg-bg-subtle p-3">
                <div className="mb-1 text-label text-ink-tertiary">添加 stdio 服务器（将进入待确认状态）</div>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="显示名称"
                  className="mb-2 w-full rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary"
                />
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="绝对路径命令（如 /usr/bin/node）"
                  className="mb-2 w-full rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary"
                />
                <textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="参数（每行一个）"
                  rows={3}
                  className="mb-2 w-full rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleAddStdio}
                    disabled={busy || !displayName.trim() || !command.trim()}
                    className="rounded-btn bg-accent px-3 py-1 text-caption text-white hover:opacity-90 disabled:opacity-50"
                  >
                    添加
                  </button>
                  <button
                    onClick={resetAdd}
                    className="rounded-btn border border-line px-3 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* Add form — loopback */}
            {addMode === 'loopback' && (
              <div className="mb-4 rounded-card border border-line bg-bg-subtle p-3">
                <div className="mb-1 text-label text-ink-tertiary">添加 loopback HTTP（仅 127.0.0.1/localhost，将进入待确认状态）</div>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="显示名称"
                  className="mb-2 w-full rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary"
                />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://127.0.0.1:13371/mcp"
                  className="mb-2 w-full rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleAddLoopback}
                    disabled={busy || !displayName.trim() || !url.trim()}
                    className="rounded-btn bg-accent px-3 py-1 text-caption text-white hover:opacity-90 disabled:opacity-50"
                  >
                    添加
                  </button>
                  <button
                    onClick={resetAdd}
                    className="rounded-btn border border-line px-3 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* Confirmation panel — shows EXACT command/args or URL, never raw stderr/instructions */}
            {pendingConfirm && (
              <div className="mb-4 rounded-card border border-accent bg-accent-bg p-3">
                <div className="mb-1 text-label text-ink-primary">激活确认</div>
                <div className="mb-2 text-caption text-ink-secondary">{pendingConfirm.riskNotice}</div>
                <div className="mb-2 text-caption text-ink-primary">
                  <div>来源：{SOURCE_LABELS[pendingConfirm.source] ?? pendingConfirm.source}</div>
                  {pendingConfirm.command !== undefined && (
                    <div className="mt-1">
                      <div>命令：<code className="break-all">{pendingConfirm.command}</code></div>
                      {pendingConfirm.args && pendingConfirm.args.length > 0 && (
                        <div>参数：<code className="break-all">{pendingConfirm.args.join(' ')}</code></div>
                      )}
                    </div>
                  )}
                  {pendingConfirm.url !== undefined && (
                    <div className="mt-1">URL：<code className="break-all">{pendingConfirm.url}</code></div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleConfirm}
                    disabled={busy}
                    className="rounded-btn bg-accent px-3 py-1 text-caption text-white hover:opacity-90 disabled:opacity-50"
                  >
                    确认激活
                  </button>
                  <button
                    onClick={() => setPendingConfirm(null)}
                    className="rounded-btn border border-line px-3 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* Server list */}
            <div className="mb-1 text-label text-ink-tertiary">已配置服务器</div>
            {store.mcpServers.length === 0 && (
              <div className="text-caption text-ink-tertiary">暂无</div>
            )}
            {store.mcpServers.map((srv) => {
              const tools = store.mcpTools[srv.id] ?? []
              return (
                <div key={srv.id} className="mb-3 rounded-card border border-line p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="text-body text-ink-primary">{srv.displayName}</div>
                      <div className="text-label text-ink-tertiary">
                        {SOURCE_LABELS[srv.source] ?? srv.source} · {MCP_STATUS_LABELS[srv.status] ?? srv.status}
                        {srv.toolCount > 0 && ` · ${srv.toolCount} 个工具`}
                      </div>
                      {/* Safe config display — no raw stderr, no instructions.
                          For trusted-built-in no command/url is shown (main-resolved). */}
                      {srv.source === 'user-stdio' && srv.command && (
                        <div className="mt-1 text-label text-ink-secondary">
                          命令：<code className="break-all">{srv.command}</code>
                          {srv.args && srv.args.length > 0 && (
                            <span> <code className="break-all">{srv.args.join(' ')}</code></span>
                          )}
                        </div>
                      )}
                      {srv.source === 'user-loopback' && srv.url && (
                        <div className="mt-1 text-label text-ink-secondary">
                          URL：<code className="break-all">{srv.url}</code>
                        </div>
                      )}
                      {/* Error: safe reason only (sanitizeError), never raw stderr */}
                      {srv.status === 'error' && srv.error && (
                        <div className="mt-1 text-label text-danger">{srv.error}</div>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(srv.source === 'user-stdio' || srv.source === 'user-loopback') && srv.status === 'pending-confirmation' && (
                      <button
                        onClick={() => handleBuildConfirm(srv.id)}
                        className="rounded-btn bg-accent px-2 py-0.5 text-caption text-white hover:opacity-90"
                      >
                        开始激活确认
                      </button>
                    )}
                    {srv.status !== 'connected' && srv.status !== 'pending-confirmation' && (
                      <button
                        onClick={() => store.enableMcp(srv.id)}
                        className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover"
                      >
                        连接
                      </button>
                    )}
                    {srv.status === 'connected' && (
                      <button
                        onClick={() => store.disableMcp(srv.id)}
                        className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover"
                      >
                        断开
                      </button>
                    )}
                    {(srv.status === 'connected' || srv.status === 'error' || srv.status === 'disconnected') && (
                      <button
                        onClick={() => store.reconnectMcp(srv.id)}
                        className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover"
                      >
                        重连
                      </button>
                    )}
                    <button
                      onClick={() => { if (confirm(`删除 ${srv.displayName}？`)) store.deleteMcp(srv.id) }}
                      className="rounded-btn border border-line px-2 py-0.5 text-caption text-danger hover:bg-bg-hover"
                    >
                      删除
                    </button>
                  </div>
                  {/* Tool inventory (inventory-only; not executable in P4) */}
                  {tools.length > 0 && (
                    <div className="mt-2 border-t border-line pt-2">
                      <div className="mb-1 text-label text-ink-tertiary">已发现工具（仅清单，P4 不可执行）</div>
                      {tools.map((t) => (
                        <div key={t.id} className="text-label text-ink-secondary">
                          · {t.name}
                          {t.description && <span className="text-ink-tertiary"> — {t.description}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

const RISK_LABELS: Record<string, string> = {
  read: '只读',
  propose: '提案',
  write: '写入',
  dangerous: '危险',
}

const STATUS_LABELS: Record<string, string> = {
  proposed: '已提议',
  'awaiting-approval': '待审批',
  started: '执行中',
  completed: '已完成',
  failed: '已失败',
}

/** A tool-call lifecycle card. Shows tool id/risk + fixed metadata + status. */
function ToolCallCard({ entry }: { entry: {
  toolCallId: string
  toolId: string
  risk: string
  inputSummary: string
  status: string
  summary?: string
  preview?: string
  /**
   * P3 propose→artifact: opaque artifact id when a propose tool persisted a
   * read-only proposal artifact. Clicking the link opens the Artifacts drawer
   * so the user can preview/copy the proposal. There is NO apply/writeback —
   * the artifact is read-only.
   */
  artifactRef?: string
  redactedError?: string
  category?: string
  token?: string
  impactSummary?: string
  impactPreview?: string
  targetScope?: string
} }) {
  const setArtifactsOpen = useAiStore((s) => s.setArtifactsOpen)
  return (
    <div className="mb-3 rounded-card border border-line bg-bg-surface px-3 py-2">
      <div className="flex items-center gap-2 text-caption">
        <span className="font-medium text-ink-primary">{entry.toolId}</span>
        <span className="rounded-btn bg-bg-subtle px-1.5 py-0.5 text-ink-secondary">
          {RISK_LABELS[entry.risk] ?? entry.risk}
        </span>
        <span className="text-ink-tertiary">{STATUS_LABELS[entry.status] ?? entry.status}</span>
      </div>
      <div className="mt-1 text-caption text-ink-tertiary">{entry.inputSummary}</div>
      {entry.summary && (
        <div className="mt-1 text-caption text-ink-secondary">{entry.summary}</div>
      )}
      {entry.preview && (
        <pre className="mt-1 max-h-40 overflow-auto rounded-btn bg-bg-subtle p-2 text-caption text-ink-secondary">
          {entry.preview}
        </pre>
      )}
      {/* P3 propose→artifact: link to the read-only proposal in the Artifacts
          drawer. The artifact is preview/copy only — NO apply/writeback. */}
      {entry.artifactRef && entry.status === 'completed' && (
        <button
          onClick={() => setArtifactsOpen(true)}
          className="mt-1 text-label text-accent hover:underline"
          title="在 Artifacts 抽屉中预览/复制（只读提案，不会写入编辑器或文件）"
        >
          📄 在 Artifacts 查看
        </button>
      )}
      {entry.redactedError && (
        <div className="mt-1 text-caption text-danger">{entry.redactedError}</div>
      )}
      {/* P3: a write tool awaiting approval renders the ApprovalCard inline. */}
      {entry.status === 'awaiting-approval' && entry.token && (
        <ApprovalCard
          token={entry.token}
          impactSummary={entry.impactSummary ?? ''}
          impactPreview={entry.impactPreview}
          targetScope={entry.targetScope ?? ''}
        />
      )}
    </div>
  )
}

/**
 * Approval card for a write tool. Shows the impact summary + scope + preview,
 * then Approve / Reject buttons. Reject REQUIRES a visible non-empty reason —
 * the Reject button is disabled until the reason input is non-empty. There is
 * NO keyboard shortcut or hidden path to approve: only the explicit Approve
 * button click calls decideApproval(token, true).
 */
function ApprovalCard({ token, impactSummary, impactPreview, targetScope }: {
  token: string
  impactSummary: string
  impactPreview?: string
  targetScope: string
}) {
  const store = useAiStore()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const rejectReasonValid = reason.trim().length > 0

  const handleApprove = async () => {
    if (busy) return
    setBusy(true)
    // Approve reason is optional/recommended. We don't force it.
    await store.decideApproval(token, true)
    setBusy(false)
  }

  const handleReject = async () => {
    if (busy || !rejectReasonValid) return
    setBusy(true)
    // Reject requires a non-empty reason. The main process also enforces this
    // (ai:approval:decide throws if the reason is empty), but the UI gates the
    // button so the user gets immediate feedback.
    await store.decideApproval(token, false, reason.trim())
    setReason('')
    setBusy(false)
  }

  return (
    <div className="mt-2 rounded-btn border border-accent/30 bg-accent-bg/30 p-2">
      <div className="text-caption font-medium text-ink-primary">需要审批（写入操作）</div>
      <div className="mt-1 text-caption text-ink-secondary">
        <span className="text-ink-tertiary">影响：</span>{impactSummary}
      </div>
      <div className="text-caption text-ink-secondary">
        <span className="text-ink-tertiary">目标范围：</span>
        <code className="rounded-btn bg-bg-subtle px-1">{targetScope}</code>
      </div>
      {impactPreview && (
        <pre className="mt-1 max-h-32 overflow-auto rounded-btn bg-bg-subtle p-2 text-caption text-ink-secondary">
          {impactPreview}
        </pre>
      )}
      <div className="mt-2 flex flex-col gap-1.5">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="拒绝原因（拒绝时必填，批准时可选）"
          className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary outline-none focus:border-accent"
          aria-label="审批原因"
        />
        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            disabled={busy}
            className="rounded-btn bg-accent px-3 py-1 text-caption text-white hover:opacity-90 disabled:opacity-40"
            aria-label="批准写入"
          >
            批准
          </button>
          <button
            onClick={handleReject}
            disabled={busy || !rejectReasonValid}
            className="rounded-btn border border-line px-3 py-1 text-caption text-danger hover:bg-bg-hover disabled:opacity-40"
            aria-label="拒绝写入（需填写原因）"
            title={!rejectReasonValid ? '拒绝必须填写原因' : ''}
          >
            拒绝
          </button>
        </div>
      </div>
    </div>
  )
}
