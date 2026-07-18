// Git Workbench tool (Task 1+2).
//
// Renderer UI: repository chooser, three file groups (staged / unstaged /
// untracked) with stage/unstage actions, and a Monaco DiffEditor for text
// diffs (placeholder for binary / too_large / submodule / empty). All git
// work goes through window.raintool.git* — the renderer never holds a cwd,
// command, or pathspec that wasn't returned by the main process's status
// snapshot.
//
// IMPORTANT (P0 fix): this top-level module MUST NOT import Monaco. The
// Monaco bundle is ~3 MB; eagerly importing it here made the Git Workbench
// dynamic chunk 3.3 MB, so opening the tool left the workspace stuck on the
// Suspense fallback `加载中…` while the chunk downloaded + parsed (and on
// any chunk-load failure the fallback was infinite). The Monaco DiffEditor
// is now isolated in `./git-workbench/diff-pane.tsx`, which is lazy-loaded
// ONLY when a text diff actually needs to render. The shell (top bar, file
// lists, commit strip) renders synchronously and is interactive before
// Monaco arrives. A `ToolErrorBoundary` wraps the lazy diff pane so a
// dynamic-import failure shows a retryable error UI instead of an infinite
// fallback. The shell never re-renders into a "loading" state once the
// controls are visible — the diff pane owns its own loading/error state.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { ToolProps } from './shared'
import { ToolErrorBoundary } from './ErrorBoundary'
import {
  getGitWorkbenchStore,
  restoreGitWorkbenchStore,
  serializeGitWorkbenchStore,
} from '@/store/git-workbench'
import { useAiStore } from '@/store/ai'
import type { GitFileChange, GitIdentity } from '../../../electron/git-types'

// Lazy-load the Monaco-backed diff pane. This is the ONLY dynamic import of
// Monaco in the renderer; Vite emits it as a separate chunk so the shell can
// render without it. The `ToolErrorBoundary` below catches a chunk-load
// failure (e.g. Monaco worker missing inside app.asar) and offers Retry.
const MonacoDiffPane = lazy(() => import('./git-workbench/diff-pane'))

const STATUS_ICON: Record<string, string> = {
  A: 'A', M: 'M', D: 'D', R: 'R', C: 'C', '?': '?', U: 'U', T: 'T',
}

const STATUS_LABEL: Record<string, string> = {
  A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', U: '未合并', T: '类型变',
}

/** One row in a file list. Click selects it for the diff pane. */
function FileRow({
  file,
  source,
  selected,
  onSelect,
  actionLabel,
  onAction,
  actionDisabled,
  secondaryLabel,
  onSecondary,
  secondaryDisabled,
}: {
  file: GitFileChange
  source: 'staged' | 'unstaged' | 'untracked'
  selected: boolean
  onSelect: () => void
  actionLabel: string
  onAction: () => void
  actionDisabled?: boolean
  /** Optional secondary action (e.g. "丢弃" on unstaged rows). Renders a
   *  second button; omit for staged/untracked rows. */
  secondaryLabel?: string
  onSecondary?: () => void
  secondaryDisabled?: boolean
}) {
  const icon = file.indexStatus || file.worktreeStatus || '?'
  return (
    <div
      onClick={onSelect}
      className={`group flex cursor-pointer items-center gap-2 px-2 py-1 text-code ${
        selected ? 'bg-accent/10' : 'hover:bg-bg-hover'
      }`}
    >
      <span
        className={`inline-block w-4 shrink-0 text-center font-bold ${
          icon === 'M' ? 'text-amber' : icon === 'A' ? 'text-green' : icon === 'D' ? 'text-red' : 'text-ink-tertiary'
        }`}
        title={STATUS_LABEL[icon] ?? icon}
      >
        {STATUS_ICON[icon] ?? icon}
      </span>
      <span className="flex-1 truncate text-ink-primary" title={file.path}>
        {file.path}
        {file.originalPath && (
          <span className="ml-1 text-ink-tertiary">← {file.originalPath}</span>
        )}
      </span>
      {onSecondary && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (!secondaryDisabled) onSecondary()
          }}
          disabled={secondaryDisabled}
          title="丢弃工作区改动（不可撤销）"
          className="shrink-0 rounded-btn border border-red/40 px-1.5 py-0.5 text-caption text-red opacity-0 transition-opacity hover:bg-red/10 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {secondaryLabel ?? '丢弃'}
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (!actionDisabled) onAction()
        }}
        disabled={actionDisabled}
        className="shrink-0 rounded-btn border border-line px-1.5 py-0.5 text-caption text-ink-secondary opacity-0 transition-opacity hover:bg-bg-hover group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
      >
        {actionLabel}
      </button>
      <span className="shrink-0 text-caption text-ink-tertiary">{source === 'staged' ? '暂存' : source === 'unstaged' ? '改动' : '未跟踪'}</span>
    </div>
  )
}

/** A file-group panel with a header and a scrollable list. */
function FileGroup({
  title,
  count,
  files,
  selection,
  source,
  actionLabel,
  onAction,
  onSelect,
  onAllAction,
  emptyHint,
  secondaryLabel,
  onSecondary,
  secondaryDisabled,
}: {
  title: string
  count: number
  files: GitFileChange[]
  selection: { path: string; source: string } | null
  source: 'staged' | 'unstaged' | 'untracked'
  actionLabel: string
  onAction: (file: GitFileChange) => void
  onSelect: (path: string, source: 'staged' | 'unstaged' | 'untracked') => void
  /** Batch action for every visible file in this group. */
  onAllAction?: (files: GitFileChange[]) => void
  emptyHint: string
  /** Optional secondary per-row action (e.g. "丢弃" on unstaged rows). */
  secondaryLabel?: string
  onSecondary?: (file: GitFileChange) => void
  secondaryDisabled?: boolean
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-card border border-line bg-bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="text-label text-ink-secondary">
          {title} <span className="text-ink-tertiary">({count})</span>
        </span>
        {files.length > 0 && onAllAction && (
          <button
            onClick={() => onAllAction(files)}
            className="rounded-btn border border-line px-1.5 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover"
          >
            {source === 'staged' ? '全部取消' : '全部暂存'}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <div className="px-3 py-3 text-caption text-ink-tertiary">{emptyHint}</div>
        ) : (
          files.map((f) => (
            <FileRow
              key={`${source}:${f.path}`}
              file={f}
              source={source}
              selected={selection?.path === f.path && selection?.source === source}
              onSelect={() => onSelect(f.path, source)}
              actionLabel={actionLabel}
              onAction={() => onAction(f)}
              secondaryLabel={secondaryLabel}
              onSecondary={onSecondary ? () => onSecondary(f) : undefined}
              secondaryDisabled={secondaryDisabled}
            />
          ))
        )}
      </div>
    </div>
  )
}

/** The diff pane: Monaco DiffEditor for text, placeholder for other kinds.
 *
 * The IPC returns COMPLETE original/modified texts (not a unified patch), so
 * Monaco consumes them directly — no renderer-side patch reconstruction.
 *
 * Monaco is lazy-loaded: only the `text` kind reaches the Monaco component.
 * Binary / too_large / submodule / empty kinds render an inline placeholder
 * without ever importing Monaco, so the user always sees something useful
 * even if Monaco fails to load. */
function DiffPane({
  diff,
  loading,
  selection,
  view,
  onToggleView,
}: {
  diff: import('../../../electron/git-types').GitDiffResult | null
  loading: boolean
  selection: { path: string; source: string } | null
  view: 'unified' | 'split'
  onToggleView: () => void
}) {
  if (!selection) {
    return <EmptyDiff text="选择一个文件查看差异" />
  }
  if (loading) {
    return <EmptyDiff text="加载差异中…" />
  }
  if (!diff) {
    return <EmptyDiff text="无差异内容" />
  }
  if (diff.kind !== 'text') {
    // binary / too_large / submodule / empty: inline placeholder, no Monaco.
    return <EmptyDiff text={diff.summary} />
  }
  // kind === 'text': original/modified are the full file texts from the IPC.
  // Plan §2.4: default unified, switchable to split. Monaco's renderSideBySide
  // = false renders inline (unified); true renders two-pane (split).
  // The ErrorBoundary catches a Monaco chunk-load failure (rare in dev, more
  // common inside a packaged app if workers are missing). Retry re-mounts.
  return (
    <ToolErrorBoundary label="Diff 编辑器" recoverHint="Monaco 编辑器加载失败，可重试；若多次失败，请重启 RainTool。">
      <Suspense fallback={<EmptyDiff text="正在加载 Diff 编辑器…" />}>
        <MonacoDiffPane
          diff={diff}
          selectionPath={selection.path}
          view={view}
          onToggleView={onToggleView}
        />
      </Suspense>
    </ToolErrorBoundary>
  )
}

function EmptyDiff({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-caption text-ink-tertiary">
      {text}
    </div>
  )
}

/**
 * Commit strip (Task 3). Renders the staged-file count, the configured git
 * identity (or a warning when unset), subject input, and the 提交 button.
 * The subject input is the confirmation gate: an empty subject disables commit,
 * so there is no separate confirmation dialog. The identity warning surfaces the
 * IDENTITY_MISSING error before the user wastes a round-trip.
 *
 * Task 4 additions:
 *  - AI 生成提交标题 button: triggers AI proposal from staged-only context. Disabled
 *    when stagedCount===0, proposing, or no active AI profile. The button NEVER
 *    commits — it only fills the subject for the user to edit + submit manually.
 *  - Transparency banner: always shown when staged files exist, reminding the
 *    user that ONLY staged content is sent to the provider and sensitive files
 *    are excluded. When proposalMeta is set, shows excluded/capped counts.
 */
function CommitStrip({
  stagedCount, identity, commitSubject, committing,
  operationInProgress, canCommit,
  onSubject, onCommit,
  // Task 4: AI proposal
  proposing, proposalMeta, activeProfileId, onPropose,
}: {
  stagedCount: number
  identity: GitIdentity | null
  commitSubject: string
  committing: boolean
  operationInProgress: boolean
  canCommit: boolean
  onSubject: (v: string) => void
  onCommit: () => void
  // Task 4: AI proposal
  proposing: boolean
  proposalMeta: {
    excludedPaths: string[]
    cappedPaths: string[]
    totalBytes: number
    totalLines: number
    truncated: boolean
  } | null
  activeProfileId: string | null
  onPropose: () => void
}) {
  const identityMissing = identity !== null && (identity.name === null || identity.email === null)
  const identityLabel = identity && identity.name !== null && identity.email !== null
    ? `${identity.name} <${identity.email}>`
    : '未配置身份 — 提交将失败'
  const overlong = commitSubject.length > 200
  const submitDisabled = !canCommit || overlong
  // 生成提交说明 enablement (defense-in-depth; store also guards):
  //   - must have staged files
  //   - must NOT be currently proposing
  //   - must NOT be committing (avoid clobbering an in-flight commit)
  //   - must have an active AI profile configured
  const proposeDisabled = stagedCount === 0 || proposing || committing || !activeProfileId
  const proposeTitle = !activeProfileId
    ? '请先在 AI 设置中配置并选择一个 Provider'
    : stagedCount === 0
      ? '没有已暂存的更改可生成说明'
      : proposing
        ? '生成中…'
        : '基于已暂存内容生成英文提交标题（仅发送暂存内容；敏感文件已排除）'
  return (
    <div className="flex flex-col gap-2 border-b border-line bg-bg-surface px-3 py-2">
      {/* Task 4 transparency banner: shown whenever staged files exist, even
          before any proposal — the user should know the data-flow upfront. */}
      {stagedCount > 0 && (
        <div className="rounded-btn bg-bg-hover px-2 py-1 text-caption text-ink-secondary">
          仅已暂存 diff 会发送给当前 Provider；未暂存、未跟踪及敏感文件内容不会发送。
          {activeProfileId
            ? ' 点击「AI 生成提交标题」后，将生成一个可编辑的英文标题；不会自动提交或推送。'
            : ' 当前未选择 AI 模型，「AI 生成提交标题」已禁用。'}
          {proposalMeta && (
            <span className="ml-1 text-ink-tertiary">
              （上次：排除 {proposalMeta.excludedPaths.length} 个、超限 {proposalMeta.cappedPaths.length} 个
              {proposalMeta.truncated ? '、上下文已截断' : ''}；{proposalMeta.totalBytes} B / {proposalMeta.totalLines} 行）
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 text-caption text-ink-secondary">
        <span>已暂存 <span className="text-ink-primary">{stagedCount}</span> 个文件</span>
        <span className={identityMissing ? 'text-red' : 'text-ink-tertiary'} title={identityLabel}>
          {identityLabel}
        </span>
        {identityMissing && (
          <span className="text-red">
            请先运行 <code className="rounded bg-bg-hover px-1">git config user.name &amp;&amp; git config user.email</code>
          </span>
        )}
        {operationInProgress && (
          <span className="text-red">合并/变基进行中 — 提交已禁用</span>
        )}
      </div>
      <input
        type="text"
        value={commitSubject}
        onChange={(e) => onSubject(e.target.value)}
        placeholder="提交标题（必填，单行）"
        maxLength={400}
        disabled={committing}
        className="w-full rounded-btn border border-line bg-bg-base px-2 py-1 text-label text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none disabled:opacity-50"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onCommit}
          disabled={submitDisabled}
          className="rounded-btn bg-accent px-3 py-1 text-label text-bg-base hover:bg-accent-hover disabled:opacity-50"
        >
          {committing ? '提交中…' : '提交'}
        </button>
        {/* Task 4: AI proposal button. NEVER auto-commits — fills the subject
            for the user to edit + submit via 提交 above. */}
        <button
          onClick={onPropose}
          disabled={proposeDisabled}
          title={proposeTitle}
          className="rounded-btn border border-line bg-bg-base px-3 py-1 text-label text-ink-primary hover:bg-bg-hover disabled:opacity-50"
        >
          {proposing ? 'AI 生成中…' : proposalMeta ? 'AI 重新生成标题' : 'AI 生成提交标题'}
        </button>
        {overlong && (
          <span className="text-caption text-red">标题过长（&gt; 200 字符）</span>
        )}
        {stagedCount === 0 && (
          <span className="text-caption text-ink-tertiary">没有已暂存的更改</span>
        )}
      </div>
    </div>
  )
}

/**
 * Discard-worktree confirmation dialog (supervisor correction 2). Names each
 * file that will be restored and shows an irreversible warning. The dialog is
 * the confirmation gate — the service cannot enforce it, but the fresh-status
 * re-validation in discardWorktreeFiles ensures the paths the user saw are the
 * paths that get restored. Only tracked unstaged files are ever passed in
 * (untracked delete is not offered; staged changes are untouched by
 * `git restore --worktree`).
 */
function DiscardConfirmDialog({
  paths,
  onCancel,
  onConfirm,
  inFlight,
}: {
  paths: string[]
  onCancel: () => void
  onConfirm: () => void
  inFlight: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="flex w-96 flex-col gap-3 rounded-card border border-line bg-bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-label text-ink-primary">确认丢弃工作区改动？</h3>
        <p className="text-caption text-red">
          ⚠ 不可撤销：以下已跟踪文件的未暂存改动将被还原到暂存区版本（已暂存改动不受影响）。
        </p>
        <ul className="max-h-48 overflow-y-auto rounded-btn border border-line bg-bg-base p-2 text-caption text-ink-primary">
          {paths.map((p) => (
            <li key={p} className="truncate" title={p}>• {p}</li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={inFlight}
            className="rounded-btn border border-line px-3 py-1 text-label text-ink-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={inFlight}
            className="rounded-btn bg-red px-3 py-1 text-label text-bg-base hover:opacity-90 disabled:opacity-50"
          >
            {inFlight ? '丢弃中…' : '确认丢弃'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * First-push dialog (supervisor correction 1). When `git push` rejects
 * NO_UPSTREAM, the UI shows this dialog: it fetches the configured remotes
 * (from `gitListRemotes`), lets the user explicitly pick one, and confirms
 * "推送 remote/branch". The main process re-validates the remote against
 * `git remote` before `git push -u <remote> <branch>` — the renderer never
 * invents a remote name, and the service never silently assumes `origin`.
 */
function FirstPushDialog({
  remotes,
  branch,
  loadingRemotes,
  inFlight,
  onCancel,
  onConfirm,
}: {
  remotes: string[]
  branch: string | null
  loadingRemotes: boolean
  inFlight: boolean
  onCancel: () => void
  onConfirm: (remote: string) => void
}) {
  const [picked, setPicked] = useState<string>('')
  useEffect(() => {
    if (remotes.length > 0 && !picked) setPicked(remotes[0])
  }, [remotes, picked])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="flex w-96 flex-col gap-3 rounded-card border border-line bg-bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-label text-ink-primary">首次推送：选择远端</h3>
        <p className="text-caption text-ink-secondary">
          当前分支 <span className="text-ink-primary">{branch ?? '(分离 HEAD)'}</span> 没有配置上游。
          请明确选择一个已配置的远端，将执行 <code className="rounded bg-bg-hover px-1">git push -u &lt;远端&gt; {branch ?? ''}</code>。
        </p>
        {loadingRemotes ? (
          <p className="text-caption text-ink-tertiary">正在读取远端列表…</p>
        ) : remotes.length === 0 ? (
          <p className="text-caption text-red">该仓库没有配置任何远端（请先用 <code>git remote add</code> 添加）。</p>
        ) : (
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            disabled={inFlight}
            className="rounded-btn border border-line bg-bg-base px-2 py-1 text-label text-ink-primary focus:border-accent focus:outline-none disabled:opacity-50"
          >
            {remotes.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={inFlight}
            className="rounded-btn border border-line px-3 py-1 text-label text-ink-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => picked && onConfirm(picked)}
            disabled={inFlight || !picked || remotes.length === 0}
            className="rounded-btn bg-accent px-3 py-1 text-label text-bg-base hover:bg-accent-hover disabled:opacity-50"
          >
            {inFlight ? '推送中…' : `推送到 ${picked || '…'}/${branch ?? ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function GitWorkbench({ tabId, config, onConfig }: ToolProps) {
  const store = useMemo(() => getGitWorkbenchStore(tabId), [tabId])
  const restored = useRef(false)
  const persistedConfig = useRef(config)
  const {
    handle, status, refreshing, selection, diff, diffLoading, error,
    identity, commitSubject, committing, fetching, pulling, pushing,
    discarding, diffView, branches, switchingBranch,
    chooseAndOpen, refresh, stage, unstage, clearError,
    setCommitSubject, commit, fetchRepo, pull, push,
    setDiffView, listRemotes, pushUpstream, discardWorktree, switchBranch,
    canCommit: canCommitFn,
    // Task 4: AI proposal state + action
    proposing, proposalMeta, proposeCommitMessage,
  } = store()
  // Task 4: read the active AI profile lazily from the AI store. No store
  // coupling at module load — useAiStore is only read here, in the component,
  // so the Git store stays independent of the AI store.
  const activeProfileId = useAiStore((s) => s.activeProfileId)
  const loadAiProfiles = useAiStore((s) => s.loadProfiles)
  const [recentOpen, setRecentOpen] = useState(false)
  // Discard-worktree confirmation state: the paths the user clicked "丢弃" on.
  const [discardPending, setDiscardPending] = useState<string[] | null>(null)
  // First-push dialog state: opened when push rejects NO_UPSTREAM.
  const [firstPushOpen, setFirstPushOpen] = useState(false)
  const [firstPushRemotes, setFirstPushRemotes] = useState<string[]>([])
  const [firstPushLoading, setFirstPushLoading] = useState(false)

  // Each Git tab persists only reconstructable values. On restart the saved
  // root is reopened to obtain a fresh repositoryId; the token itself is never
  // written to disk because the main-process registry is intentionally
  // ephemeral.
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    void restoreGitWorkbenchStore(store, config)
  }, [config, store])

  useEffect(() => store.subscribe(() => {
    const next = serializeGitWorkbenchStore(store)
    if (next === persistedConfig.current) return
    persistedConfig.current = next
    onConfig?.(next)
  }), [onConfig, store])

  // Git Workbench can be opened before AI Assistant. Hydrate the model list
  // here as well so AI commit-message generation is available independently.
  useEffect(() => {
    void loadAiProfiles()
  }, [loadAiProfiles])

  // Auto-refresh when the tool mounts (if a repo is already open from a
  // previous tab session — store is module-scoped, so state persists).
  useEffect(() => {
    if (handle && !status) void refresh()
  }, [handle, status, refresh])

  const summary = status?.repository
  const aheadBehind = useMemo(() => {
    if (!summary) return null
    const parts: string[] = []
    if (summary.ahead > 0) parts.push(`↑${summary.ahead}`)
    if (summary.behind > 0) parts.push(`↓${summary.behind}`)
    return parts.length ? parts.join(' ') : null
  }, [summary])

  const operationInProgress = !!summary && summary.operation !== 'normal'
  const stagedCount = status?.staged.length ?? 0
  // Plan §2.6 commit-button enablement (audit correction): the predicate lives
  // in the store (canCommit()) so it's testable without rendering the component.
  // It requires: handle + staged>0 + LOADED identity (both name+email) + non-empty
  // subject + not committing + operation normal. The backend gate re-checks all
  // of these; this is the UX + defense-in-depth layer.
  const canCommit = canCommitFn()
  const canPush = !!handle && !!summary?.branch && !pushing && !operationInProgress
  const canPull = !!handle && !!summary?.upstream && !pulling && !operationInProgress
  const canFetch = !!handle && !fetching && !operationInProgress

  // Push: if the service rejects NO_UPSTREAM, open the first-push dialog
  // (explicit remote/branch confirmation) instead of silently assuming origin.
  const handlePush = async () => {
    await push()
    const st = store.getState()
    if (st.errorCode === 'NO_UPSTREAM') {
      setFirstPushOpen(true)
      setFirstPushLoading(true)
      setFirstPushRemotes([])
      try {
        const remotes = await listRemotes()
        setFirstPushRemotes(remotes)
      } finally {
        setFirstPushLoading(false)
      }
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar: repo chooser + status summary */}
      <div className="flex items-center gap-2 border-b border-line bg-bg-surface px-3 py-2">
        {handle ? (
          <>
            <span className="text-label text-ink-primary" title={handle.root}>
              📁 {handle.displayName}
            </span>
            {summary?.branch ? (
              <select
                value={summary.branch}
                onChange={(event) => void switchBranch(event.target.value)}
                disabled={switchingBranch || operationInProgress}
                aria-label="切换 Git 分支"
                title="切换到已有本地分支；若会覆盖本地改动，Git 会安全拒绝"
                className="rounded-btn border border-line bg-bg-hover px-2 py-0.5 text-caption text-ink-secondary outline-none disabled:opacity-50"
              >
                {(branches.length > 0 ? branches : [summary.branch]).map((branch) => (
                  <option key={branch} value={branch}>{branch}</option>
                ))}
              </select>
            ) : summary?.isDetached ? (
              <span className="rounded-btn bg-bg-hover px-2 py-0.5 text-caption text-ink-secondary">
                分离 HEAD {summary.headSha?.slice(0, 7)}
              </span>
            ) : null}
            {summary?.operation && summary.operation !== 'normal' && (
              <span className="rounded-btn bg-amber/20 px-2 py-0.5 text-caption text-amber">
                {summary.operation} 进行中
              </span>
            )}
            {aheadBehind && (
              <span className="text-caption text-ink-tertiary">{aheadBehind}</span>
            )}
            <div className="ml-auto flex gap-1.5">
              <button
                onClick={() => setRecentOpen((v) => !v)}
                className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
              >
                最近
              </button>
              <button
                onClick={() => void fetchRepo()}
                disabled={!canFetch}
                className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover disabled:opacity-50"
                title="git fetch --prune"
              >
                {fetching ? '拉取引用中…' : 'Fetch'}
              </button>
              <button
                onClick={() => void pull()}
                disabled={!canPull}
                className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover disabled:opacity-50"
                title="git pull --ff-only"
              >
                {pulling ? '拉取中…' : 'Pull'}
              </button>
              <button
                onClick={() => void handlePush()}
                disabled={!canPush}
                className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover disabled:opacity-50"
                title="git push"
              >
                {pushing ? '推送中…' : 'Push'}
              </button>
              <button
                onClick={() => void refresh()}
                disabled={refreshing}
                className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover disabled:opacity-50"
              >
                {refreshing ? '刷新中…' : '刷新'}
              </button>
              <button
                onClick={() => void chooseAndOpen()}
                className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
              >
                切换仓库
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="text-label text-ink-tertiary">未选择仓库</span>
            <div className="ml-auto flex gap-1.5">
              <button
                onClick={() => setRecentOpen((v) => !v)}
                className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover"
              >
                最近仓库
              </button>
              <button
                onClick={() => void chooseAndOpen()}
                className="rounded-btn border border-accent bg-accent/10 px-3 py-1 text-caption text-accent hover:bg-accent/20"
              >
                选择仓库…
              </button>
            </div>
          </>
        )}
      </div>

      {/* Recent repos dropdown */}
      {recentOpen && <RecentRepos onPicked={(p) => { setRecentOpen(false); void store.getState().openRepository(p) }} onClose={() => setRecentOpen(false)} />}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 border-b border-red/30 bg-red/10 px-3 py-1.5 text-caption text-red">
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="text-ink-tertiary hover:text-ink-primary">✕</button>
        </div>
      )}

      {/* Commit strip (Task 3): staged count + identity + subject + 提交.
          Task 4: + 生成提交标题 button + transparency banner. */}
      {handle && (
        <CommitStrip
          stagedCount={stagedCount}
          identity={identity}
          commitSubject={commitSubject}
          committing={committing}
          operationInProgress={operationInProgress}
          canCommit={canCommit}
          onSubject={setCommitSubject}
          onCommit={() => void commit()}
          // Task 4: AI proposal. The button NEVER auto-commits — it fills
          // subject for the user to edit + submit via 提交. proposeCommitMessage
          // reads activeProfileId lazily inside the store action.
          proposing={proposing}
          proposalMeta={proposalMeta}
          activeProfileId={activeProfileId}
          onPropose={() => void proposeCommitMessage(activeProfileId)}
        />
      )}

      {/* Empty state or main layout */}
      {!handle ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-ink-tertiary">
            <div className="text-4xl">📂</div>
            <div className="text-label">选择一个 Git 仓库开始</div>
            <button
              onClick={() => void chooseAndOpen()}
              className="rounded-btn border border-accent bg-accent/10 px-4 py-1.5 text-label text-accent hover:bg-accent/20"
            >
              选择仓库目录…
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Left: three file groups */}
          <div className="flex w-80 shrink-0 flex-col gap-2 overflow-hidden border-r border-line p-2">
            <div className="flex min-h-0 flex-1 flex-col">
              <FileGroup
                title="已暂存"
                count={status?.staged.length ?? 0}
                files={status?.staged ?? []}
                selection={selection}
                source="staged"
                actionLabel="取消暂存"
                onAction={(f) => void unstage([f.path])}
                onSelect={(path, source) => void store.getState().selectFile({ path, source })}
                onAllAction={(files) => void unstage(files.map((file) => file.path))}
                emptyHint="无已暂存文件"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <FileGroup
                title="未暂存"
                count={status?.unstaged.length ?? 0}
                files={status?.unstaged ?? []}
                selection={selection}
                source="unstaged"
                actionLabel="暂存"
                onAction={(f) => void stage([f.path])}
                onSelect={(path, source) => void store.getState().selectFile({ path, source })}
                onAllAction={(files) => void stage(files.map((file) => file.path))}
                secondaryLabel="丢弃"
                onSecondary={(f) => setDiscardPending([f.path])}
                secondaryDisabled={discarding || operationInProgress}
                emptyHint="无未暂存改动"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <FileGroup
                title="未跟踪"
                count={status?.untracked.length ?? 0}
                files={status?.untracked ?? []}
                selection={selection}
                source="untracked"
                actionLabel="暂存"
                onAction={(f) => void stage([f.path])}
                onSelect={(path, source) => void store.getState().selectFile({ path, source })}
                onAllAction={(files) => void stage(files.map((file) => file.path))}
                emptyHint="无未跟踪文件"
              />
            </div>
          </div>

          {/* Right: diff pane */}
          <div className="min-h-0 flex-1">
            <DiffPane
              diff={diff}
              loading={diffLoading}
              selection={selection}
              view={diffView}
              onToggleView={() => setDiffView(diffView === 'split' ? 'unified' : 'split')}
            />
          </div>
        </div>
      )}

      {/* Discard-worktree confirmation (names each file + irreversible warning) */}
      {discardPending && (
        <DiscardConfirmDialog
          paths={discardPending}
          inFlight={discarding}
          onCancel={() => setDiscardPending(null)}
          onConfirm={async () => {
            const paths = discardPending
            setDiscardPending(null)
            await discardWorktree(paths)
          }}
        />
      )}

      {/* First-push dialog (explicit remote/branch confirmation on NO_UPSTREAM) */}
      {firstPushOpen && (
        <FirstPushDialog
          remotes={firstPushRemotes}
          branch={summary?.branch ?? null}
          loadingRemotes={firstPushLoading}
          inFlight={pushing}
          onCancel={() => setFirstPushOpen(false)}
          onConfirm={async (remote) => {
            await pushUpstream(remote)
            // Close only if the push succeeded (errorCode cleared).
            if (!store.getState().errorCode) setFirstPushOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** Recent-repositories dropdown; fetches the list on open. */
function RecentRepos({ onPicked, onClose }: { onPicked: (path: string) => void; onClose: () => void }) {
  const [list, setList] = useState<import('../../../electron/git-types').GitRecentRepository[]>([])
  useEffect(() => {
    void window.raintool.gitListRecentRepositories().then(setList)
  }, [])
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-3 top-12 z-50 w-80 rounded-card border border-line bg-bg-surface shadow-lg">
        {list.length === 0 ? (
          <div className="px-3 py-3 text-caption text-ink-tertiary">暂无最近仓库</div>
        ) : (
          list.map((r) => (
            <button
              key={r.root}
              onClick={() => onPicked(r.root)}
              className="block w-full truncate px-3 py-2 text-left text-code text-ink-primary hover:bg-bg-hover"
              title={r.root}
            >
              {r.displayName}
              <span className="ml-2 text-caption text-ink-tertiary">{r.root}</span>
            </button>
          ))
        )}
      </div>
    </>
  )
}
