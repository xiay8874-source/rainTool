// Git Workbench renderer store (Task 1+2+3).
//
// Renderer-only state: the open repositoryId, the latest status snapshot, the
// selected file + diff source, the fetched diff, identity, commit message
// draft, per-operation loading flags, and a per-action error string (cleared
// on the next successful action). No API keys, no cwd, no git command
// strings — the renderer only ever holds a repositoryId (opaque token
// allocated by the main process) and the structured status/diff/sync results
// it returns.

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type {
  GitCommitInput,
  GitCommitResult,
  GitBranchListResult,
  GitDiffRequest,
  GitDiffResult,
  GitIdentity,
  GitPushUpstreamInput,
  GitRepositoryHandle,
  GitStatus,
  GitSyncResult,
  GitSwitchBranchInput,
} from '../../electron/git-types'

/** A pending file selection: which file, viewed from which side. */
export interface GitSelection {
  path: string
  source: 'staged' | 'unstaged' | 'untracked'
}

export interface GitWorkbenchState {
  /** The currently open repository handle (null = no repo, show empty state). */
  handle: GitRepositoryHandle | null
  /** Latest status snapshot; null while loading or before first refresh. */
  status: GitStatus | null
  /** True while a status refresh is in flight. */
  refreshing: boolean
  /** Currently selected file + diff source (null = no selection). */
  selection: GitSelection | null
  /** Diff for the current selection; null while loading / not yet fetched. */
  diff: GitDiffResult | null
  /** True while a diff is being fetched. */
  diffLoading: boolean
  /** Last error from any action (open/refresh/stage/unstage/diff/commit/sync). Cleared on next success. */
  error: string | null
  /** Last error's structured code (for tailoring the UI message). */
  errorCode: string | null

  // ---- Task 3: commit / sync state ----
  /** Git author identity (null until loaded; {name:null,email:null} when unset). */
  identity: GitIdentity | null
  /** Commit message draft (subject + body). Cleared on successful commit. */
  commitSubject: string
  commitBody: string
  /** Per-operation loading flags; disable the corresponding button while true. */
  committing: boolean
  fetching: boolean
  pulling: boolean
  pushing: boolean
  /** True while a discard-worktree or first-push is in flight. */
  discarding: boolean
  /** Diff view preference (plan §2.4: default unified, switchable to split). */
  diffView: 'unified' | 'split'
  /** Existing local branches and branch-switch loading state. */
  branches: string[]
  switchingBranch: boolean

  // ---- Task 4: AI commit-message proposal state ----
  /** True while the AI is generating a commit-message proposal. */
  proposing: boolean
  /** Transparency metadata from the last proposal (excluded/capped paths,
   *  whether the staged context was truncated). Cleared on commit. Null until
   *  the first proposal returns. Used by the UI banner to show the user
   *  exactly what was (and was NOT) sent to the provider. */
  proposalMeta: {
    excludedPaths: string[]
    cappedPaths: string[]
    totalBytes: number
    totalLines: number
    truncated: boolean
  } | null

  // ---- actions ----
  openRepository: (absPath: string) => Promise<boolean>
  chooseAndOpen: () => Promise<boolean>
  refresh: () => Promise<void>
  selectFile: (sel: GitSelection | null) => Promise<void>
  stage: (paths: string[]) => Promise<void>
  unstage: (paths: string[]) => Promise<void>
  loadBranches: () => Promise<void>
  switchBranch: (branch: string) => Promise<void>
  clearError: () => void

  // ---- Task 3 actions ----
  loadIdentity: () => Promise<void>
  setCommitSubject: (subject: string) => void
  setCommitBody: (body: string) => void
  commit: () => Promise<void>
  fetchRepo: () => Promise<void>
  pull: () => Promise<void>
  push: () => Promise<void>

  // ---- Supervisor corrections: explicit first-push + discard + view toggle ----
  setDiffView: (view: 'unified' | 'split') => void
  listRemotes: () => Promise<string[]>
  pushUpstream: (remote: string) => Promise<void>
  discardWorktree: (paths: string[]) => Promise<void>

  // ---- Task 4: AI commit-message proposal ----
  /** Generate an AI commit-message proposal from the CURRENTLY STAGED files.
   *  Reads the active AI profile lazily from the AI store (no store coupling
   *  at module load). On success: writes subject+body into the existing
   *  commitSubject/commitBody inputs (the user freely edits + uses the
   *  existing Commit button). NEVER auto-stages/commits/pushes. On error:
   *  sets error/errorCode and leaves commitSubject/commitBody untouched
   *  (no partial fill). Guards on: handle, staged > 0, !proposing.
   *  modelProfileId is the active AI profile id; if null/empty, the action
   *  is a no-op (the UI disables the button in that case, but the guard is
   *  defense-in-depth). */
  proposeCommitMessage: (modelProfileId: string | null) => Promise<void>

  /**
   * Plan §2.6 commit-button enablement predicate (audit correction): the commit
   * button is enabled only when ALL of:
   *   - a repo is open (handle !== null)
   *   - at least one staged file (status.staged.length > 0)
   *   - identity is LOADED and has BOTH name + email (not null/unloaded)
   *   - subject is non-empty after trim
   *   - not currently committing
   *   - no merge/rebase/cherry-pick/bisect in progress
   * The backend (service.commit) re-checks identity/staged/operation; this
   * selector is the UX + defense-in-depth layer so the button is DISABLED (not
   * just failing post-click) when identity is unset. Exported as a store method
   * so tests can assert the rule without rendering the component.
   */
  canCommit: () => boolean
}

/** Parse the main-process `[git:CODE] message` IPC error into code + message. */
function parseGitIpcError(e: unknown): { code: string; message: string } {
  const msg = e instanceof Error ? e.message : String(e)
  const m = msg.match(/^\[git:([A-Z_]+)\]\s*(.*)$/)
  if (m) return { code: m[1], message: m[2] }
  // Non-git error (e.g. assertTrustedRenderer rejection) — surface raw.
  return { code: 'COMMAND_FAILED', message: msg }
}

export type GitWorkbenchStore = UseBoundStore<StoreApi<GitWorkbenchState>>

/**
 * Create one complete Git Workbench state container.
 *
 * A factory is required because a duplicated workspace tab must own its own
 * repository, branch, selection, diff and commit draft. Keeping a single
 * module-level Zustand store made every Git tab mirror every other Git tab.
 */
export function createGitWorkbenchStore(): GitWorkbenchStore {
  return create<GitWorkbenchState>((set, get) => ({
  handle: null,
  status: null,
  refreshing: false,
  selection: null,
  diff: null,
  diffLoading: false,
  error: null,
  errorCode: null,

  identity: null,
  commitSubject: '',
  commitBody: '',
  committing: false,
  fetching: false,
  pulling: false,
  pushing: false,
  discarding: false,
  diffView: 'unified',
  branches: [],
  switchingBranch: false,
  proposing: false,
  proposalMeta: null,

  async openRepository(absPath) {
    try {
      const handle = await window.raintool.gitOpenRepository(absPath)
      set({ handle, error: null, errorCode: null, status: null, selection: null, diff: null, identity: null, branches: [] })
      await get().refresh()
      void get().loadIdentity()
      void get().loadBranches()
      return true
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ error: message, errorCode: code })
      return false
    }
  },

  async chooseAndOpen() {
    try {
      const chosen = await window.raintool.gitChooseRepository()
      if (!chosen) return false
      return get().openRepository(chosen)
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ error: message, errorCode: code })
      return false
    }
  },

  async refresh() {
    const { handle } = get()
    if (!handle) return
    set({ refreshing: true, error: null, errorCode: null })
    try {
      const status = await window.raintool.gitRefreshStatus(handle.repositoryId)
      set({ status, refreshing: false })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ refreshing: false, error: message, errorCode: code })
    }
  },

  async selectFile(sel) {
    const { handle, diffView } = get()
    if (!handle || !sel) {
      set({ selection: null, diff: null })
      return
    }
    set({ selection: sel, diff: null, diffLoading: true, error: null, errorCode: null })
    try {
      const req: GitDiffRequest = {
        repositoryId: handle.repositoryId,
        path: sel.path,
        source: sel.source,
        view: diffView,
      }
      const diff = await window.raintool.gitGetDiff(req)
      set({ diff, diffLoading: false })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ diffLoading: false, error: message, errorCode: code })
    }
  },

  async stage(paths) {
    const { handle, selection } = get()
    if (!handle) return
    try {
      const status = await window.raintool.gitStageFiles(handle.repositoryId, paths)
      set({ status, error: null, errorCode: null })
      if (selection && paths.includes(selection.path) && selection.source !== 'staged') {
        await get().selectFile({ path: selection.path, source: 'staged' })
      }
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ error: message, errorCode: code })
    }
  },

  async unstage(paths) {
    const { handle, selection } = get()
    if (!handle) return
    try {
      const status = await window.raintool.gitUnstageFiles(handle.repositoryId, paths)
      set({ status, error: null, errorCode: null })
      if (selection && paths.includes(selection.path) && selection.source === 'staged') {
        await get().selectFile({ path: selection.path, source: 'unstaged' })
      }
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ error: message, errorCode: code })
    }
  },

  async loadBranches() {
    const { handle } = get()
    if (!handle) return
    try {
      const result: GitBranchListResult = await window.raintool.gitListBranches(handle.repositoryId)
      set({ branches: result.branches })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ error: message, errorCode: code })
    }
  },

  async switchBranch(branch) {
    const { handle, switchingBranch } = get()
    if (!handle || switchingBranch || !branch) return
    set({ switchingBranch: true, error: null, errorCode: null })
    try {
      const input: GitSwitchBranchInput = { repositoryId: handle.repositoryId, branch }
      const status = await window.raintool.gitSwitchBranch(input)
      set({
        status,
        switchingBranch: false,
        selection: null,
        diff: null,
        commitSubject: '',
        commitBody: '',
        proposalMeta: null,
      })
      void get().loadBranches()
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ switchingBranch: false, error: message, errorCode: code })
    }
  },

  clearError() {
    set({ error: null, errorCode: null })
  },

  // ---- Task 3 actions ----

  async loadIdentity() {
    const { handle } = get()
    if (!handle) return
    try {
      const identity = await window.raintool.gitGetIdentity(handle.repositoryId)
      set({ identity })
    } catch (e) {
      // Identity load failure is non-fatal; surface as a soft error.
      const { code, message } = parseGitIpcError(e)
      set({ error: message, errorCode: code })
    }
  },

  setCommitSubject(commitSubject) {
    set({ commitSubject })
  },

  setCommitBody(commitBody) {
    set({ commitBody })
  },

  async commit() {
    const { handle, commitSubject, commitBody, committing } = get()
    if (!handle || committing) return
    set({ committing: true, error: null, errorCode: null })
    try {
      const input: GitCommitInput = {
        repositoryId: handle.repositoryId,
        subject: commitSubject,
        body: commitBody,
      }
      const result: GitCommitResult = await window.raintool.gitCommit(input)
      // Commit clears the staged set + the message draft; keep the diff pane
      // in sync by clearing the selection (the just-committed file is no longer staged).
      set({
        status: result.status,
        commitSubject: '',
        commitBody: '',
        committing: false,
        selection: null,
        diff: null,
        proposalMeta: null,
      })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ committing: false, error: message, errorCode: code })
    }
  },

  async fetchRepo() {
    const { handle, fetching } = get()
    if (!handle || fetching) return
    set({ fetching: true, error: null, errorCode: null })
    try {
      const result: GitSyncResult = await window.raintool.gitFetch(handle.repositoryId)
      set({ status: result.status, fetching: false })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ fetching: false, error: message, errorCode: code })
    }
  },

  async pull() {
    const { handle, pulling } = get()
    if (!handle || pulling) return
    set({ pulling: true, error: null, errorCode: null })
    try {
      const result: GitSyncResult = await window.raintool.gitPull(handle.repositoryId)
      set({ status: result.status, pulling: false, selection: null, diff: null })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ pulling: false, error: message, errorCode: code })
    }
  },

  async push() {
    const { handle, pushing } = get()
    if (!handle || pushing) return
    set({ pushing: true, error: null, errorCode: null })
    try {
      const result: GitSyncResult = await window.raintool.gitPush(handle.repositoryId)
      set({ status: result.status, pushing: false })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ pushing: false, error: message, errorCode: code })
    }
  },

  // ---- Supervisor corrections: explicit first-push + discard + view toggle ----

  setDiffView(view) {
    const { selection } = get()
    set({ diffView: view })
    // Re-fetch the current diff with the new view so the pane reflects it.
    if (selection) void get().selectFile(selection)
  },

  async listRemotes() {
    const { handle } = get()
    if (!handle) return []
    try {
      const result = await window.raintool.gitListRemotes(handle.repositoryId)
      return result.remotes
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ error: message, errorCode: code })
      return []
    }
  },

  async pushUpstream(remote) {
    const { handle, pushing } = get()
    if (!handle || pushing) return
    set({ pushing: true, error: null, errorCode: null })
    try {
      const input: GitPushUpstreamInput = { repositoryId: handle.repositoryId, remote }
      const result: GitSyncResult = await window.raintool.gitPushUpstream(input)
      set({ status: result.status, pushing: false })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ pushing: false, error: message, errorCode: code })
    }
  },

  async discardWorktree(paths) {
    const { handle, discarding } = get()
    if (!handle || discarding) return
    set({ discarding: true, error: null, errorCode: null })
    try {
      const status: GitStatus = await window.raintool.gitDiscardWorktreeFiles(handle.repositoryId, paths)
      // Discard may change the selected file's worktree content → re-fetch diff
      // so the pane doesn't show stale text. Clear selection if the file is now
      // unchanged (it'll drop out of the unstaged group on refresh).
      set({ status, discarding: false, selection: null, diff: null })
    } catch (e) {
      const { code, message } = parseGitIpcError(e)
      set({ discarding: false, error: message, errorCode: code })
    }
  },

  async proposeCommitMessage(modelProfileId) {
    // Defense-in-depth guards (the UI also disables the button).
    const { handle, status, proposing } = get()
    if (!handle || proposing) return
    if (!status || status.staged.length === 0) return
    if (!modelProfileId) {
      // No active AI profile — surface a clear error instead of silently no-op'ing.
      set({ error: '请先在 AI 设置中配置并选择一个 Provider', errorCode: 'AI_UNAVAILABLE' })
      return
    }
    set({ proposing: true, error: null, errorCode: null })
    try {
      // The renderer passes ONLY repositoryId + modelProfileId. The main
      // process collects the staged context (redacted + capped) via the
      // closed Git service and calls the existing AI platform — no cwd,
      // argv, paths, or diff text cross the IPC boundary.
      const result = await window.raintool.gitProposeCommitMessage({
        repositoryId: handle.repositoryId,
        modelProfileId,
      })
      // Editable handoff: write the proposal into the existing commit inputs.
      // The user can freely edit + then click the existing Commit button.
      // NEVER auto-stage/commit/push here.
      set({
        commitSubject: result.subject,
        commitBody: '',
        proposalMeta: {
          excludedPaths: result.excludedPaths,
          cappedPaths: result.cappedPaths,
          totalBytes: result.totalBytes,
          totalLines: result.totalLines,
          truncated: result.truncated,
        },
        proposing: false,
      })
    } catch (e) {
      // On ANY failure (provider down, schema invalid, timeout): leave
      // commitSubject/commitBody UNTOUCHED (no partial fill) so the user's
      // in-progress draft is preserved.
      const { code, message } = parseGitIpcError(e)
      set({ proposing: false, error: message, errorCode: code })
    }
  },

  canCommit() {
    const { handle, status, identity, commitSubject, committing } = get()
    if (!handle) return false
    if (!status || status.staged.length === 0) return false
    // Identity must be LOADED (not null) and have BOTH name + email. A null
    // identity (still loading, or load failed) disables commit — the backend
    // gate (service.commit) would reject IDENTITY_MISSING anyway, but the UI
    // must reflect the plan §2.6 enablement rule proactively.
    if (!identity || identity.name === null || identity.email === null) return false
    if (!commitSubject.trim()) return false
    if (committing) return false
    if (status.repository.operation !== 'normal') return false
    return true
  },
  }))
}

/** Legacy/default instance retained for store-level consumers and tests. */
export const useGitWorkbench = createGitWorkbenchStore()

/** One independent store per workspace tab. */
const tabStores = new Map<string, GitWorkbenchStore>()

export function getGitWorkbenchStore(tabId?: string): GitWorkbenchStore {
  if (!tabId) return useGitWorkbench
  const existing = tabStores.get(tabId)
  if (existing) return existing
  const created = createGitWorkbenchStore()
  tabStores.set(tabId, created)
  return created
}

/**
 * Copy the visible/stable snapshot when the user chooses "复制此页". Actions
 * remain bound to the destination store and all in-flight flags are reset, so
 * subsequent repository/branch/file changes are completely independent.
 */
export function cloneGitWorkbenchStore(sourceTabId: string, destinationTabId: string): void {
  const source = getGitWorkbenchStore(sourceTabId).getState()
  const destination = getGitWorkbenchStore(destinationTabId)
  destination.setState({
    handle: source.handle ? { ...source.handle } : null,
    status: source.status ? structuredClone(source.status) : null,
    selection: source.selection ? { ...source.selection } : null,
    diff: source.diff ? structuredClone(source.diff) : null,
    identity: source.identity ? { ...source.identity } : null,
    commitSubject: source.commitSubject,
    commitBody: source.commitBody,
    diffView: source.diffView,
    branches: [...source.branches],
    proposalMeta: source.proposalMeta
      ? {
          ...source.proposalMeta,
          excludedPaths: [...source.proposalMeta.excludedPaths],
          cappedPaths: [...source.proposalMeta.cappedPaths],
        }
      : null,
    refreshing: false,
    diffLoading: false,
    error: null,
    errorCode: null,
    committing: false,
    fetching: false,
    pulling: false,
    pushing: false,
    discarding: false,
    switchingBranch: false,
    proposing: false,
  })
}

export function deleteGitWorkbenchStore(tabId: string): void {
  tabStores.delete(tabId)
}

export interface GitWorkbenchPersistedState {
  version: 1
  repositoryRoot: string | null
  commitSubject: string
  diffView: 'unified' | 'split'
  selection: GitSelection | null
}

/** Only durable, safe-to-recreate values are persisted. repositoryId is an
 * in-memory main-process token and is deliberately never persisted. */
export function serializeGitWorkbenchStore(store: GitWorkbenchStore): string {
  const state = store.getState()
  const snapshot: GitWorkbenchPersistedState = {
    version: 1,
    repositoryRoot: state.handle?.root ?? null,
    commitSubject: state.commitSubject,
    diffView: state.diffView,
    selection: state.selection ? { ...state.selection } : null,
  }
  return JSON.stringify(snapshot)
}

export function parseGitWorkbenchPersistedState(config?: string): GitWorkbenchPersistedState | null {
  if (!config) return null
  try {
    const value = JSON.parse(config) as Partial<GitWorkbenchPersistedState>
    if (value.version !== 1) return null
    if (value.repositoryRoot !== null && typeof value.repositoryRoot !== 'string') return null
    if (typeof value.commitSubject !== 'string') return null
    if (value.diffView !== 'unified' && value.diffView !== 'split') return null
    const selection = value.selection
    if (
      selection !== null
      && (
        !selection
        || typeof selection.path !== 'string'
        || !['staged', 'unstaged', 'untracked'].includes(selection.source ?? '')
      )
    ) return null
    return {
      version: 1,
      repositoryRoot: value.repositoryRoot ?? null,
      commitSubject: value.commitSubject,
      diffView: value.diffView,
      selection: selection ? { path: selection.path!, source: selection.source! } : null,
    }
  } catch {
    return null
  }
}

/** Recreate a tab after app restart. The persisted absolute root is reopened
 * to obtain a fresh opaque repositoryId, then status and the selected diff are
 * refreshed through the normal trusted IPC path. */
export async function restoreGitWorkbenchStore(store: GitWorkbenchStore, config?: string): Promise<void> {
  const saved = parseGitWorkbenchPersistedState(config)
  if (!saved) return
  store.setState({ commitSubject: saved.commitSubject, diffView: saved.diffView })
  if (!saved.repositoryRoot) return
  const opened = await store.getState().openRepository(saved.repositoryRoot)
  if (!opened) return
  store.setState({ commitSubject: saved.commitSubject, diffView: saved.diffView })
  if (saved.selection) await store.getState().selectFile(saved.selection)
}
