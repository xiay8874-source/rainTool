// Model Settings page (P0-1).
//
// Replaces the old "模型与凭据" modal (SettingsDrawer) with a full settings
// page: a supplier sidebar (each supplier = base URL + protocol + credential +
// enable flag) and a detail panel (edit supplier config + per-supplier model
// list). TokenHub is seeded by the main process as the default supplier.
//
// Layout: left sidebar lists suppliers with an enable toggle + add button;
// right panel shows the selected supplier's config (display name, provider,
// protocol, base URL, credential) and its model list (add/remove/toggle each
// model). Disabled suppliers are greyed; their models are excluded from the AI
// assistant dropdown + Git AI (enforced main-side via getEnabled/listEnabled).
//
// Security: raw API keys never leave this page except through aiSaveSupplier,
// which sends the key to the main process for safeStorage encryption. The
// renderer only ever holds the masked credential status. Credential save is
// transactional (main persists the credential first, then the supplier) so a
// failed save leaves no orphan supplier.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAiStore } from '@/store/ai'
import type {
  AiModelProfile,
  AiProtocol,
  AiProviderId,
  AiSupplier,
} from '../../../electron/ai-platform/ai-types'

const PROVIDER_OPTIONS: { value: AiProviderId; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'ollama', label: 'Ollama (本地)' },
  { value: 'anthropic', label: 'Anthropic' },
]

const PROTOCOL_OPTIONS: { value: AiProtocol; label: string; hint: string }[] = [
  { value: 'openai-chat', label: 'OpenAI Chat', hint: 'POST /chat/completions（兼容 Ollama / OpenRouter / TokenHub）' },
  { value: 'openai-responses', label: 'OpenAI Responses', hint: 'POST /responses（新版 OpenAI 接口）' },
  { value: 'anthropic-messages', label: 'Anthropic Messages', hint: 'POST /v1/messages（Anthropic 原生 SSE 流）' },
]

const PROTOCOL_BY_PROVIDER: Record<AiProviderId, AiProtocol> = {
  'openai-compatible': 'openai-chat',
  ollama: 'openai-chat',
  anthropic: 'anthropic-messages',
  google: 'openai-chat',
}

export function ModelSettings({ onClose }: { onClose: () => void }) {
  const store = useAiStore()
  // Extract stable action references for the mount effect. The whole-store
  // `store` reference changes on every set(), so `[store]` as a dep would
  // re-fire the effect on every state change → constant IPC re-fetch loop.
  // Zustand actions are defined once in create(), so these selector refs are
  // stable across renders and the effect fires exactly once on mount.
  const loadSuppliers = useAiStore((s) => s.loadSuppliers)
  const loadProfiles = useAiStore((s) => s.loadProfiles)
  const [selectedId, setSelectedId] = useState<string | null>(store.suppliers[0]?.id ?? null)
  const [editing, setEditing] = useState(false)

  // Hydrate suppliers + profiles on mount.
  useEffect(() => {
    void loadSuppliers()
    void loadProfiles()
  }, [loadSuppliers, loadProfiles])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Keep a valid selection when the supplier list changes (delete/disable).
  useEffect(() => {
    if (selectedId && store.suppliers.some((s) => s.id === selectedId)) return
    setSelectedId(store.suppliers[0]?.id ?? null)
  }, [store.suppliers, selectedId])

  const selected = useMemo(
    () => store.suppliers.find((s) => s.id === selectedId) ?? null,
    [store.suppliers, selectedId],
  )

  return (
    <div className="fixed inset-0 z-50 flex bg-bg-app" role="dialog" aria-modal="true" aria-label="模型设置">
      {/* Sidebar: supplier list */}
      <aside className="flex w-64 flex-col border-r border-line bg-bg-surface">
        <div className="flex items-center justify-between border-b border-line px-3 py-3">
          <span className="text-page text-ink-primary">模型设置</span>
          <button
            type="button"
            onClick={onClose}
            className="no-drag -mr-1 inline-flex h-7 w-7 items-center justify-center rounded-btn text-caption text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary"
            aria-label="关闭模型设置"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {store.suppliers.length === 0 && (
            <div className="px-3 py-4 text-caption text-ink-tertiary">暂无供应商</div>
          )}
          {store.suppliers.map((s) => {
            const credStatus = store.credentialStatuses[s.credentialKey]
            const needsKey = !isLoopback(s.baseUrl) && !(credStatus?.configured)
            return (
              <button
                key={s.id}
                onClick={() => { setSelectedId(s.id); setEditing(false) }}
                className={`block w-full px-3 py-2 text-left hover:bg-bg-hover ${
                  selectedId === s.id ? 'bg-bg-subtle' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    role="switch"
                    aria-checked={s.enabled}
                    aria-label={`切换 ${s.displayName} 启用`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void store.setSupplierEnabled(s.id, !s.enabled)
                    }}
                    className={`inline-flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors ${
                      s.enabled ? 'bg-accent' : 'bg-line'
                    }`}
                  >
                    <span className={`h-3 w-3 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-3' : ''}`} />
                  </span>
                  <span className={`flex-1 truncate text-body ${s.enabled ? 'text-ink-primary' : 'text-ink-tertiary'}`}>
                    {s.displayName}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-label text-ink-tertiary">
                  {s.baseUrl || '(默认地址)'} · {PROTOCOL_OPTIONS.find((p) => p.value === s.protocol)?.label ?? s.protocol}
                  {needsKey && <span className="text-amber"> · 未配置凭据</span>}
                </div>
              </button>
            )
          })}
        </div>
        <button
          onClick={() => { setSelectedId(null); setEditing(true) }}
          className="border-t border-line px-3 py-2 text-left text-caption text-accent hover:bg-bg-hover"
        >
          + 添加供应商
        </button>
      </aside>

      {/* Detail panel */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {editing || !selected ? (
          <SupplierEditor
            supplier={selected}
            onCancel={() => { setEditing(false); setSelectedId(store.suppliers[0]?.id ?? null) }}
          />
        ) : (
          <SupplierDetail supplier={selected} onEdit={() => setEditing(true)} />
        )}
      </div>
    </div>
  )
}

function SupplierDetail({ supplier, onEdit }: { supplier: AiSupplier; onEdit: () => void }) {
  const store = useAiStore()
  // Seed from the assistant store so an existing enabled model is visible on
  // the first paint, then fetch the authoritative list (including disabled
  // models) from the main process. Writes also update this local list
  // immediately; the IPC refresh is reconciliation, not the only way the UI
  // can discover that a write succeeded.
  const [profiles, setProfiles] = useState<AiModelProfile[]>(() =>
    store.profiles.filter((p) => p.supplierId === supplier.id),
  )
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const refreshProfiles = useCallback(async () => {
    setProfilesLoading(true)
    try {
      const all = await window.raintool.aiListProfiles()
      setProfiles(all.filter((p) => p.supplierId === supplier.id))
      setProfileError(null)
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : '读取模型列表失败')
    } finally {
      setProfilesLoading(false)
    }
  }, [supplier.id])
  useEffect(() => {
    setProfiles(store.profiles.filter((p) => p.supplierId === supplier.id))
    void refreshProfiles()
  }, [supplier.id, refreshProfiles])
  const credStatus = store.credentialStatuses[supplier.credentialKey]
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [newModelName, setNewModelName] = useState('')
  const [newModelDisplay, setNewModelDisplay] = useState('')
  const [savingModel, setSavingModel] = useState(false)

  const handleAddModel = async () => {
    if (!newModelName.trim() || savingModel) return
    setSavingModel(true)
    setProfileError(null)
    try {
      const created = await window.raintool.aiCreateProfile({
        providerId: supplier.providerId,
        displayName: newModelDisplay.trim() || newModelName.trim(),
        model: newModelName.trim(),
        baseUrl: supplier.baseUrl,
        credentialKey: supplier.credentialKey,
        supplierId: supplier.id,
        enabled: true,
        capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
      })
      setProfiles((current) => [created, ...current.filter((p) => p.id !== created.id)])
      setNewModelName('')
      setNewModelDisplay('')
      setAddModelOpen(false)
      await Promise.all([store.loadProfiles(), refreshProfiles()])
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : '添加模型失败')
    } finally {
      setSavingModel(false)
    }
  }

  const handleToggleModel = async (id: string, enabled: boolean) => {
    // Atomic toggle: touches ONLY `enabled`, never re-upserts the whole
    // profile. The old path re-upserted (read-all → find → rebuild), which
    // was both fragile (could clobber supplier-owned fields via the omit
    // fallback) and a duplicate risk if the intermediate profile lacked an
    // id. setEnabled is atomic and idempotent.
    setProfileError(null)
    try {
      const updated = await window.raintool.aiSetProfileEnabled(id, !enabled)
      setProfiles((current) => current.map((p) => (p.id === id ? updated : p)))
      await Promise.all([store.loadProfiles(), refreshProfiles()])
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : '切换模型状态失败')
    }
  }

  const handleDeleteModel = async (id: string) => {
    setProfileError(null)
    try {
      await window.raintool.aiDeleteProfile(id)
      setProfiles((current) => current.filter((p) => p.id !== id))
      await Promise.all([store.loadProfiles(), refreshProfiles()])
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : '删除模型失败')
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 flex items-center gap-3">
          <span className="text-page text-ink-primary">{supplier.displayName}</span>
          <span className={`rounded-btn px-2 py-0.5 text-caption ${supplier.enabled ? 'bg-accent-bg text-accent' : 'bg-bg-subtle text-ink-tertiary'}`}>
            {supplier.enabled ? '已启用' : '已禁用'}
          </span>
          <button onClick={onEdit} className="ml-auto rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover">
            编辑
          </button>
          <button
            onClick={() => { if (confirm(`删除供应商 ${supplier.displayName} 及其所有模型？`)) void store.deleteSupplier(supplier.id) }}
            className="rounded-btn border border-line px-2 py-1 text-caption text-danger hover:bg-bg-hover"
          >
            删除
          </button>
        </div>

        <div className="mb-6 rounded-card border border-line bg-bg-surface p-4">
          <Row label="Provider">{PROVIDER_OPTIONS.find((p) => p.value === supplier.providerId)?.label ?? supplier.providerId}</Row>
          <Row label="协议">{PROTOCOL_OPTIONS.find((p) => p.value === supplier.protocol)?.label ?? supplier.protocol}</Row>
          <Row label="Base URL">{supplier.baseUrl || '(默认地址)'}</Row>
          <Row label="凭据">
            {credStatus?.configured
              ? `已配置 ${credStatus.maskedPreview ?? ''}`
              : isLoopback(supplier.baseUrl) ? '本地服务，无需凭据' : '未配置'}
            {credStatus && !credStatus.encryptionAvailable && '（加密不可用）'}
          </Row>
        </div>

        <div className="mb-2 flex items-center justify-between">
          <span className="text-label text-ink-secondary">模型列表</span>
          <button
            onClick={() => setAddModelOpen((v) => !v)}
            className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
          >
            + 添加模型
          </button>
        </div>
        {addModelOpen && (
          <div className="mb-3 rounded-card border border-line bg-bg-subtle p-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-caption text-ink-secondary">模型名
                <input value={newModelName} onChange={(e) => setNewModelName(e.target.value)} placeholder="如 GLM-5.2 / gpt-4o-mini" className="mt-0.5 w-full rounded-btn border border-line bg-bg-surface px-2 py-1 text-body text-ink-primary outline-none focus:border-accent" />
              </label>
              <label className="text-caption text-ink-secondary">显示名（可选）
                <input value={newModelDisplay} onChange={(e) => setNewModelDisplay(e.target.value)} className="mt-0.5 w-full rounded-btn border border-line bg-bg-surface px-2 py-1 text-body text-ink-primary outline-none focus:border-accent" />
              </label>
            </div>
            <div className="mt-2 flex gap-2">
              <button onClick={handleAddModel} disabled={!newModelName.trim() || savingModel} className="rounded-btn bg-accent px-3 py-1 text-caption text-white hover:opacity-90 disabled:opacity-40">{savingModel ? '添加中…' : '添加'}</button>
              <button onClick={() => setAddModelOpen(false)} className="rounded-btn border border-line px-3 py-1 text-caption text-ink-secondary hover:bg-bg-hover">取消</button>
            </div>
          </div>
        )}
        {profileError && <div className="mb-2 rounded-card border border-danger/30 bg-bg-surface p-3 text-caption text-danger">{profileError}</div>}
        {profilesLoading && profiles.length === 0 && <div className="p-3 text-caption text-ink-tertiary">正在读取模型…</div>}
        {!profilesLoading && profiles.length === 0 && (
          <div className="rounded-card border border-line bg-bg-surface p-4 text-caption text-ink-tertiary">
            该供应商下暂无模型。点击「添加模型」新建。
          </div>
        )}
        {profiles.map((p) => (
          <div key={p.id} className="mb-2 flex items-center gap-2 rounded-card border border-line bg-bg-surface px-3 py-2">
            <span
              role="switch"
              aria-checked={p.enabled !== false}
              aria-label={`切换 ${p.displayName} 启用`}
              onClick={() => void handleToggleModel(p.id, p.enabled !== false)}
              className={`inline-flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors ${p.enabled !== false ? 'bg-accent' : 'bg-line'}`}
            >
              <span className={`h-3 w-3 rounded-full bg-white transition-transform ${p.enabled !== false ? 'translate-x-3' : ''}`} />
            </span>
            <div className="flex-1">
              <div className={`text-body ${p.enabled !== false ? 'text-ink-primary' : 'text-ink-tertiary'}`}>{p.displayName}</div>
              <div className="text-label text-ink-tertiary">{p.model}</div>
            </div>
            <button
              onClick={() => void handleDeleteModel(p.id)}
              className="text-caption text-ink-tertiary hover:text-danger"
              aria-label={`删除 ${p.displayName}`}
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function SupplierEditor({ supplier, onCancel }: { supplier: AiSupplier | null; onCancel: () => void }) {
  const store = useAiStore()
  const [displayName, setDisplayName] = useState(supplier?.displayName ?? '')
  const [providerId, setProviderId] = useState<AiProviderId>(supplier?.providerId ?? 'openai-compatible')
  const [protocol, setProtocol] = useState<AiProtocol>(supplier?.protocol ?? 'openai-chat')
  const [baseUrl, setBaseUrl] = useState(supplier?.baseUrl ?? '')
  const [rawKey, setRawKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // When the provider changes, default the protocol to that provider's native
  // protocol (unless the user explicitly changed it).
  const [protocolTouched, setProtocolTouched] = useState(!!supplier)
  useEffect(() => {
    if (!protocolTouched) setProtocol(PROTOCOL_BY_PROVIDER[providerId])
  }, [providerId, protocolTouched])

  const handleSave = async () => {
    if (!displayName.trim()) return
    setSaving(true)
    setError(null)
    try {
      const result = await store.saveSupplier({
        supplier: {
          ...(supplier?.id ? { id: supplier.id } : {}),
          displayName: displayName.trim(),
          providerId,
          protocol,
          baseUrl: baseUrl.trim() || undefined,
          credentialKey: supplier?.credentialKey ?? '',
          enabled: supplier?.enabled ?? true,
        },
        rawKey: rawKey.trim() || undefined,
      })
      if (!result.ok) {
        setError(result.reason === 'encryption-unavailable' ? '本机加密不可用，凭据未保存，供应商未创建' : '保存失败')
        return
      }
      onCancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存供应商失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 text-page text-ink-primary">{supplier ? '编辑供应商' : '添加供应商'}</div>
        <div className="rounded-card border border-line bg-bg-surface p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-caption text-ink-secondary">显示名
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如 TokenHub / OpenAI / 我的 Ollama" className="mt-0.5 w-full rounded-btn border border-line bg-bg-base px-2 py-1 text-body text-ink-primary outline-none focus:border-accent" />
            </label>
            <label className="text-caption text-ink-secondary">Provider
              <select
                value={providerId}
                onChange={(e) => setProviderId(e.target.value as AiProviderId)}
                className="mt-0.5 w-full rounded-btn border border-line bg-bg-base px-2 py-1 text-body text-ink-primary outline-none focus:border-accent"
              >
                {PROVIDER_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
            <label className="col-span-2 text-caption text-ink-secondary">协议
              <select
                value={protocol}
                onChange={(e) => { setProtocol(e.target.value as AiProtocol); setProtocolTouched(true) }}
                className="mt-0.5 w-full rounded-btn border border-line bg-bg-base px-2 py-1 text-body text-ink-primary outline-none focus:border-accent"
              >
                {PROTOCOL_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label} — {p.hint}</option>)}
              </select>
            </label>
            <label className="col-span-2 text-caption text-ink-secondary">Base URL
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:15722/v1（TokenHub 默认）" className="mt-0.5 w-full rounded-btn border border-line bg-bg-base px-2 py-1 text-body text-ink-primary outline-none focus:border-accent" />
            </label>
            <label className="col-span-2 text-caption text-ink-secondary">API Key（加密保存，永不回传；本地服务可留空）
              <input value={rawKey} onChange={(e) => setRawKey(e.target.value)} type="password" placeholder="sk-... / 留空使用既有凭据" className="mt-0.5 w-full rounded-btn border border-line bg-bg-base px-2 py-1 text-body text-ink-primary outline-none focus:border-accent" />
            </label>
          </div>
          {error && <div className="mt-3 text-caption text-danger">{error}</div>}
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !displayName.trim()}
              className="rounded-btn bg-accent px-4 py-1.5 text-caption text-white hover:opacity-90 disabled:opacity-40"
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button onClick={onCancel} className="rounded-btn border border-line px-4 py-1.5 text-caption text-ink-secondary hover:bg-bg-hover">取消</button>
          </div>
          <div className="mt-3 text-label text-ink-tertiary">
            密钥通过 Electron safeStorage 加密保存，仅主进程可读。渲染层、日志、会话 JSON 均不携带密钥。凭据保存失败时不会创建供应商（无孤儿记录）。
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-caption">
      <span className="w-24 shrink-0 text-ink-tertiary">{label}</span>
      <span className="flex-1 text-ink-primary">{children}</span>
    </div>
  )
}

function isLoopback(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}
