// Git Workbench repository service (Task 1).
//
// Owns the repoId → validated-root registry. The renderer never supplies a
// cwd or root to any git command — only an opaque repositoryId that this
// service allocated via openRepository(). Unknown/expired ids are rejected,
// so a stale UI cannot drive a command against a path the user hasn't
// re-validated.
//
// Status is parsed from `git status --porcelain=v2 -z --branch` via the
// runner's parser. Path validation (assertSafePathspec) rejects absolute
// paths, '..', NUL bytes, and paths not present in the current status
// snapshot — every write IPC re-validates against a FRESH status before the
// command is built, so a path that was valid a moment ago but no longer
// exists is caught here, not at the git layer.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  GitRunner,
  GitRunnerError,
  parsePorcelainV2,
  groupFiles,
} from './git-runner.js'
import {
  isSecretPath,
  isRestrictedContent,
  buildStagedContextPrompt,
  type StagedFileContext,
  type StagedContextResult,
} from './ai-platform/ai-commit-proposer.js'
import type {
  GitBranchListResult,
  GitCommitInput,
  GitCommitResult,
  GitDiffRequest,
  GitDiffResult,
  GitError,
  GitFileChange,
  GitIdentity,
  GitPushUpstreamInput,
  GitRecentRepository,
  GitRemoteListResult,
  GitRepositoryHandle,
  GitRepositorySummary,
  GitStatus,
  GitSwitchBranchInput,
  GitSyncResult,
} from './git-types.js'

/** Max recent-repository entries persisted. */
const MAX_RECENT = 10
/** Files larger than this (bytes) are not diffed as text (UI shows too_large).
 *  Plan §2.4: 2 MiB. */
const DIFF_SIZE_CAP_BYTES = 2 * 1024 * 1024
/** Plan §2.4: 50,000 lines. A text diff exceeding this many lines on either
 *  side is reported as too_large (the UI shows "文件过大" + line count). */
const DIFF_LINE_CAP = 50_000
/** Max commit subject length (single-line title). */
const COMMIT_SUBJECT_MAX = 200

/**
 * In-memory registry of open repositories. repositoryId → handle. An id is
 * allocated on openRepository and lives for the app session; the renderer
 * caches it and must re-open if the app restarts.
 */
export class GitRepositoryService {
  private readonly repos = new Map<string, GitRepositoryHandle>()
  private readonly runner: GitRunner
  private readonly recentPath: string

  constructor(runner?: GitRunner) {
    this.runner = runner ?? new GitRunner()
    this.recentPath = path.join(app.getPath('home'), 'raintool', 'git-recent-repos.json')
  }

  /**
   * Open a repository: canonicalize via `rev-parse --show-toplevel`, reject
   * being inside `.git`, allocate a repositoryId, remember it. Returns the
   * handle (with the id the renderer uses for all subsequent calls).
   */
  async openRepository(absPath: string): Promise<GitRepositoryHandle> {
    if (!absPath || typeof absPath !== 'string') {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '仓库路径为空'))
    }
    if (/[\/\\]\.git([\/\\]|$)/.test(absPath)) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '不能直接打开 .git 目录'))
    }
    // rev-parse needs a cwd that exists; if the path doesn't exist, fail fast.
    if (!existsSync(absPath)) {
      throw toGitError(new GitRunnerError('NOT_REPOSITORY', '所选路径不存在'))
    }
    let root: string
    try {
      root = await this.runner.revParseTopLevel(absPath)
    } catch (e) {
      throw toGitError(e)
    }
    if (!root) {
      throw toGitError(new GitRunnerError('NOT_REPOSITORY', '所选目录不是 Git 仓库'))
    }
    // Reject opening the .git dir itself or a path resolving into it.
    if (path.basename(root) === '.git' || /[\/\\]\.git([\/\\]|$)/.test(root)) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '不能直接打开 .git 目录'))
    }
    const handle: GitRepositoryHandle = {
      repositoryId: `repo_${randomUUID()}`,
      root,
      displayName: path.basename(root),
      openedAt: Date.now(),
    }
    this.repos.set(handle.repositoryId, handle)
    void this.saveRecent(handle)
    return handle
  }

  /** Resolve a repositoryId to its handle, or throw on unknown/expired. */
  resolve(repositoryId: string): GitRepositoryHandle {
    const handle = this.repos.get(repositoryId)
    if (!handle) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '未知的仓库 ID，请重新选择仓库'))
    }
    return handle
  }

  /** Read full status: summary + staged/unstaged/untracked file groups. */
  async getStatus(repositoryId: string): Promise<GitStatus> {
    const handle = this.resolve(repositoryId)
    let raw: Buffer
    try {
      raw = await this.runner.statusPorcelainV2(handle.root)
    } catch (e) {
      throw toGitError(e)
    }
    const parsed = parsePorcelainV2(raw)
    const groups = groupFiles(parsed.files)
    const headSha = await this.runner.revParseHead(handle.root)
    const operation = detectOperation(handle.root)
    const summary: GitRepositorySummary = {
      root: handle.root,
      displayName: handle.displayName,
      branch: parsed.branch,
      headSha,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      isDetached: parsed.isDetached,
      operation,
    }
    return { repository: summary, staged: groups.staged, unstaged: groups.unstaged, untracked: groups.untracked }
  }

  /**
   * Stage files. Paths are validated against a FRESH status snapshot before
   * the command runs: only paths present in staged+unstaged+untracked are
   * allowed, and each must pass validatePaths (no absolute, '..', NUL).
   */
  async stageFiles(repositoryId: string, paths: string[]): Promise<void> {
    const handle = this.resolve(repositoryId)
    const allowed = await this.allowedPaths(repositoryId)
    const safe = validatePaths(paths, allowed)
    try {
      await this.runner.add(handle.root, safe)
    } catch (e) {
      throw toGitError(e)
    }
  }

  /** Unstage files (git restore --staged). Same path validation as stage. */
  async unstageFiles(repositoryId: string, paths: string[]): Promise<void> {
    const handle = this.resolve(repositoryId)
    const allowed = await this.allowedPaths(repositoryId)
    const safe = validatePaths(paths, allowed)
    try {
      await this.runner.restoreStaged(handle.root, safe)
    } catch (e) {
      throw toGitError(e)
    }
  }

  /**
   * Compute a diff for one file and return the COMPLETE original/modified
   * texts so the renderer can hand them to Monaco's DiffEditor directly — no
   * unified patch, no renderer-side reconstruction.
   *
   * `source` selects the comparison:
   *   - staged:    original = HEAD:<path>   modified = :0:<path>   (index)
   *   - unstaged:  original = :0:<path>     modified = worktree file
   *   - untracked: original = ''            modified = worktree file
   *
   * Path is re-validated against a FRESH status snapshot. Binary / oversized /
   * submodule / empty cases are detected up front and returned as a non-`text`
   * kind so the renderer shows a placeholder without receiving blob text.
   */
  async getDiff(req: GitDiffRequest): Promise<GitDiffResult> {
    const handle = this.resolve(req.repositoryId)
    if (req.source !== 'staged' && req.source !== 'unstaged' && req.source !== 'untracked') {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', `未知 diff source: ${req.source}`))
    }
    const allowed = await this.allowedPaths(req.repositoryId)
    const safe = validatePaths([req.path], allowed)
    const rel = safe[0]
    const abs = path.join(handle.root, rel)

    // Submodule: a directory at <root>/<rel> with a .git child.
    try {
      const st = statSync(abs)
      if (st.isDirectory() && existsSync(path.join(abs, '.git'))) {
        return { kind: 'submodule', view: req.view, summary: `${rel} 是子模块,不支持行级 Diff` }
      }
    } catch {
      // path may not exist on disk (deleted worktree file) — handled below.
    }

    // Too-large pre-check via catFileSize (HEAD/:0) and disk stat (worktree).
    // We fetch the MAX side size; if either exceeds the cap, skip the blob read.
    const headSize = await this.runner.catFileSize(handle.root, 'HEAD', rel)
    const indexSize = await this.runner.catFileSize(handle.root, ':0', rel)
    let worktreeSize: number | null = null
    try { worktreeSize = statSync(abs).size } catch { worktreeSize = null }
    const maxSize = Math.max(headSize ?? 0, indexSize ?? 0, worktreeSize ?? 0)
    if (maxSize > DIFF_SIZE_CAP_BYTES) {
      return {
        kind: 'too_large',
        view: req.view,
        summary: `${rel} 超过 ${Math.round(DIFF_SIZE_CAP_BYTES / (1024 * 1024))} MiB,已跳过`,
      }
    }

    // Fetch the two sides per source. Missing blobs (new/deleted file) → ''.
    // The size pre-check above already told us whether each blob exists:
    // `catFileSize` returns null for a missing blob, so we pass the size in and
    // readBlobText returns '' WITHOUT spawning — and only a confirmed-present
    // blob reaches showBlob, so a timeout / GIT_NOT_FOUND / COMMAND_FAILED
    // there is a REAL error that must propagate (not be swallowed as "missing").
    // readBlobText returns { text, truncated }; truncated is a safety backstop
    // for a race that grew the blob between the pre-check and the fetch.
    let original: string
    let modified: string
    let truncated = false
    if (req.source === 'staged') {
      const o = await this.readBlobText(handle.root, 'HEAD', rel, headSize)
      const m = await this.readBlobText(handle.root, ':0', rel, indexSize)
      original = o.text; modified = m.text; truncated = o.truncated || m.truncated
    } else if (req.source === 'unstaged') {
      const o = await this.readBlobText(handle.root, ':0', rel, indexSize)
      original = o.text; modified = await this.readWorktreeText(abs); truncated = o.truncated
    } else {
      // untracked: empty → worktree
      original = ''
      modified = await this.readWorktreeText(abs)
    }

    // Binary detection: git treats a blob as binary if it contains a NUL byte
    // in the first ~8 KiB. We sniff both sides the same way.
    if (isBinary(original) || isBinary(modified)) {
      return { kind: 'binary', view: req.view, summary: `${rel} 是二进制文件` }
    }
    // Line cap (plan §2.4: 50,000 lines). Count newlines on both sides; if
    // either exceeds the cap, report too_large rather than shipping a huge text
    // payload to Monaco. +1 because a trailing-newline-less final line still
    // counts as a line.
    const lineCount = (s: string) => (s.length === 0 ? 0 : s.split('\n').length)
    if (lineCount(original) > DIFF_LINE_CAP || lineCount(modified) > DIFF_LINE_CAP) {
      return {
        kind: 'too_large',
        view: req.view,
        summary: `${rel} 超过 ${DIFF_LINE_CAP.toLocaleString()} 行,已跳过`,
      }
    }
    // Empty diff (e.g. staged-then-worktree-reverted-to-match-index, or a
    // brand-new empty file).
    if (original === modified) {
      return { kind: 'empty', view: req.view, summary: `${rel} 无差异` }
    }
    return {
      kind: 'text',
      original,
      modified,
      language: guessLanguage(rel),
      view: req.view,
      truncated,
      summary: truncated
        ? `${rel} ${req.source === 'staged' ? '已暂存' : req.source === 'unstaged' ? '未暂存' : '未跟踪'}改动（已截断）`
        : `${rel} ${req.source === 'staged' ? '已暂存' : req.source === 'unstaged' ? '未暂存' : '未跟踪'}改动`,
    }
  }

  /**
   * Read a git blob as utf8 text. Returns '' ONLY when the blob is known to be
   * missing (size === null, from the catFileSize pre-check) — in that case we
   * don't even spawn. When size !== null the blob exists, so any error from
   * showBlob (COMMAND_TIMEOUT / GIT_NOT_FOUND / COMMAND_FAILED) is a REAL
   * failure and is propagated — never swallowed as "missing". This prevents a
   * timeout or a broken git install from silently degrading a diff to ''.
   *
   * The `cap` is passed explicitly (DIFF_SIZE_CAP_BYTES, 2 MiB) so the blob is
   * fetched in full when it passed the size pre-check — NOT truncated to a
   * stale 256 KiB default. Returns `{ text, truncated }`; `truncated` is true
   * only if a race grew the blob between the pre-check and the fetch (a safety
   * backstop the UI surfaces via GitDiffResult.truncated).
   */
  private async readBlobText(
    root: string,
    treeIsh: 'HEAD' | ':0',
    rel: string,
    size: number | null,
  ): Promise<{ text: string; truncated: boolean }> {
    if (size === null) return { text: '', truncated: false } // blob absent
    // Pass the exact bounded size as the cap (+1 byte headroom for safety) so
    // a confirmed-undersized blob is fetched in full. Fall back to the policy
    // cap if size is 0 (an empty blob still spawns showBlob returning '').
    const cap = size > 0 ? size + 1 : DIFF_SIZE_CAP_BYTES
    return this.runner.showBlob(root, treeIsh, rel, cap)
  }

  /** Read a worktree file as utf8 text; '' if missing (deleted on disk). */
  private async readWorktreeText(abs: string): Promise<string> {
    try {
      return readFileSync(abs, 'utf8')
    } catch {
      return '' // deleted on disk → empty modified side
    }
  }

  /** Read git identity (for the commit-button enablement). Returns nulls when
   *  unset; the commit() gate interprets null name/email as IDENTITY_MISSING. */
  async getIdentity(repositoryId: string): Promise<GitIdentity> {
    const handle = this.resolve(repositoryId)
    try {
      return {
        name: await this.runner.configGet(handle.root, 'user.name'),
        email: await this.runner.configGet(handle.root, 'user.email'),
      }
    } catch (e) {
      throw toGitError(e)
    }
  }

  // ---- Task 3: commit / fetch / pull / push ----

  /**
   * Commit staged files. Gates (in order, all BEFORE any git mutation):
   *   1. resolve(repositoryId)
   *   2. subject: trim; reject empty → EMPTY_COMMIT; reject > COMMIT_SUBJECT_MAX → EMPTY_COMMIT
   *      body: reject NUL bytes → REPOSITORY_UNSAFE
   *   3. identity: name && email must both be set → else IDENTITY_MISSING
   *   4. fresh status: staged.length > 0 → else NO_STAGED_CHANGES
   *   5. operation === 'normal' → else MERGE_OR_REBASE_IN_PROGRESS
   * Then `git commit -F -` (message via stdin). Hook failures → HOOK_FAILED.
   * A race (staged set emptied between check and commit) → EMPTY_COMMIT.
   * Returns the new HEAD sha + a refreshed status.
   */
  async commit(input: GitCommitInput): Promise<GitCommitResult> {
    const handle = this.resolve(input.repositoryId)
    const subject = (input.subject ?? '').trim()
    if (!subject) {
      throw toGitError(new GitRunnerError('EMPTY_COMMIT', '提交标题不能为空'))
    }
    if (subject.length > COMMIT_SUBJECT_MAX) {
      throw toGitError(new GitRunnerError('EMPTY_COMMIT', `提交标题过长（>${COMMIT_SUBJECT_MAX} 字）`))
    }
    if (input.body != null && input.body.includes('\0')) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '提交正文含非法字符'))
    }
    const identity = await this.getIdentity(input.repositoryId)
    if (!identity.name || !identity.email) {
      throw toGitError(new GitRunnerError('IDENTITY_MISSING', '未配置 Git 身份（user.name / user.email），请先运行 git config 设置后再提交'))
    }
    const status = await this.getStatus(input.repositoryId)
    if (status.staged.length === 0) {
      throw toGitError(new GitRunnerError('NO_STAGED_CHANGES', '没有已暂存的改动可提交'))
    }
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    try {
      await this.runner.commit(handle.root, subject, input.body ?? '')
    } catch (e) {
      throw toGitError(e)
    }
    const headSha = await this.runner.revParseHead(handle.root)
    const refreshed = await this.getStatus(input.repositoryId)
    return { headSha: headSha ?? '', status: refreshed }
  }

  /**
   * `git fetch --prune` — update remote refs without touching the worktree.
   * Gate: operation === 'normal' (fetch during a merge/rebase is confusing).
   * Auth failures → AUTH_REQUIRED. Returns a refreshed status.
   */
  async fetch(repositoryId: string): Promise<GitSyncResult> {
    const handle = this.resolve(repositoryId)
    const status = await this.getStatus(repositoryId)
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    try {
      await this.runner.fetch(handle.root)
    } catch (e) {
      throw toGitError(e)
    }
    return { status: await this.getStatus(repositoryId), summary: '已更新远端引用' }
  }

  /**
   * `git pull --ff-only` — fast-forward only; never creates a merge commit.
   * Gates: operation === 'normal'; upstream must be set (else NO_UPSTREAM).
   * A diverged remote → REMOTE_DIVERGED (no merge commit is ever created).
   */
  async pullFfOnly(repositoryId: string): Promise<GitSyncResult> {
    const handle = this.resolve(repositoryId)
    const status = await this.getStatus(repositoryId)
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    if (!status.repository.upstream) {
      throw toGitError(new GitRunnerError('NO_UPSTREAM', '当前分支没有配置上游，无法拉取'))
    }
    try {
      await this.runner.pullFfOnly(handle.root)
    } catch (e) {
      throw toGitError(e)
    }
    return { status: await this.getStatus(repositoryId), summary: '已快进拉取' }
  }

  /**
   * Push the current branch to its CONFIGURED upstream only. Gates:
   *   - resolve → operation === 'normal'
   *   - branch must not be detached (else REPOSITORY_UNSAFE)
   *   - upstream MUST be set (else NO_UPSTREAM — the UI then guides the user
   *     through an explicit remote/branch confirmation via pushUpstream; we
   *     NEVER silently assume `origin`)
   * Then `git push`. Auth → AUTH_REQUIRED; non-fast-forward → REMOTE_DIVERGED.
   * Never force-pushes (no such method exists on GitRunner).
   */
  async push(repositoryId: string): Promise<GitSyncResult> {
    const handle = this.resolve(repositoryId)
    const status = await this.getStatus(repositoryId)
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    const branch = status.repository.branch
    if (!branch) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '分离 HEAD 状态无法推送，请先 checkout 到一个分支'))
    }
    if (!status.repository.upstream) {
      // Do NOT silently pick a remote. Surface NO_UPSTREAM with guidance; the
      // UI offers an explicit remote picker (from listRemotes) + confirmation,
      // then calls pushUpstream(repositoryId, remote).
      throw toGitError(new GitRunnerError(
        'NO_UPSTREAM',
        `当前分支 ${branch} 没有配置上游。请通过"首次推送"明确选择一个远端后再执行 git push -u`,
      ))
    }
    try {
      await this.runner.push(handle.root)
    } catch (e) {
      throw toGitError(e)
    }
    return { status: await this.getStatus(repositoryId), summary: '已推送' }
  }

  /**
   * List configured remotes (`git remote`). Used by the UI to populate the
   * first-push remote picker — the renderer never invents a remote name, it
   * picks from this server-returned list.
   */
  async listRemotes(repositoryId: string): Promise<GitRemoteListResult> {
    const handle = this.resolve(repositoryId)
    try {
      const remotes = await this.runner.remoteList(handle.root)
      return { remotes }
    } catch (e) {
      throw toGitError(e)
    }
  }

  /** List existing local branches for the branch switcher. */
  async listBranches(repositoryId: string): Promise<GitBranchListResult> {
    const handle = this.resolve(repositoryId)
    try {
      const [branches, status] = await Promise.all([
        this.runner.localBranchList(handle.root),
        this.getStatus(repositoryId),
      ])
      return { branches, current: status.repository.branch }
    } catch (e) {
      throw toGitError(e)
    }
  }

  /** Switch to an existing local branch. The requested name must be an exact
   * member of the fresh local-branch list, so the renderer cannot inject an
   * option or create a branch. Git refuses if local changes would be lost. */
  async switchBranch(input: GitSwitchBranchInput): Promise<GitStatus> {
    const handle = this.resolve(input.repositoryId)
    const status = await this.getStatus(input.repositoryId)
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    const branch = (input.branch ?? '').trim()
    let branches: string[]
    try {
      branches = await this.runner.localBranchList(handle.root)
    } catch (e) {
      throw toGitError(e)
    }
    if (!branch || !branches.includes(branch)) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '目标分支不存在，请刷新分支列表后重试'))
    }
    if (branch === status.repository.branch) return status
    try {
      await this.runner.switchBranch(handle.root, branch)
    } catch (e) {
      throw toGitError(e)
    }
    return this.getStatus(input.repositoryId)
  }

  /**
   * First push with explicit tracking: `git push -u <remote> <branch>`.
   * `remote` is renderer-confirmed BUT server-validated against `git remote`
   * (it must be in the list). `branch` is the CURRENT branch from the fresh
   * status snapshot (never renderer-supplied). Gates:
   *   - resolve → operation === 'normal'
   *   - branch must not be detached (else REPOSITORY_UNSAFE)
   *   - remote must be a non-empty string matching a configured remote
   *     (else REPOSITORY_UNSAFE — never spawn `git push -u <arbitrary>`)
   *   - remote must not contain shell metacharacters / NUL (defense in depth;
   *     `shell:false` already prevents injection, but we reject early so a bad
   *     name never reaches spawn)
   * Auth → AUTH_REQUIRED; non-fast-forward → REMOTE_DIVERGED. Never force-pushes.
   */
  async pushUpstream(input: GitPushUpstreamInput): Promise<GitSyncResult> {
    const handle = this.resolve(input.repositoryId)
    const status = await this.getStatus(input.repositoryId)
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    const branch = status.repository.branch
    if (!branch) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '分离 HEAD 状态无法推送，请先 checkout 到一个分支'))
    }
    const remote = (input.remote ?? '').trim()
    if (!remote) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '未选择远端'))
    }
    if (remote.includes('\0') || /[\/\\:\s]/.test(remote)) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '远端名称含非法字符'))
    }
    // Server-side validation: the remote must actually be configured. This is
    // the closed-contract guarantee that closes the silent-origin hole — we
    // never spawn `git push -u <unverified> <branch>`.
    let remotes: string[]
    try {
      remotes = await this.runner.remoteList(handle.root)
    } catch (e) {
      throw toGitError(e)
    }
    if (!remotes.includes(remote)) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', `远端 ${remote} 不存在，请从已配置的远端中选择`))
    }
    try {
      await this.runner.pushUpstream(handle.root, remote, branch)
    } catch (e) {
      throw toGitError(e)
    }
    return { status: await this.getStatus(input.repositoryId), summary: `已推送到 ${remote}/${branch} 并设置上游` }
  }

  /**
   * Discard UNSTAGED worktree changes on TRACKED files only
   * (`git restore --worktree -- <paths>`). Gates (all BEFORE any mutation):
   *   1. resolve(repositoryId)
   *   2. fresh status → every path MUST be in the UNSTAGED group (tracked,
   *      modified in worktree). Untracked paths are rejected (first version
   *      offers no delete). Staged-only paths are rejected (staged changes
   *      must be untouched by a "discard unstaged" action).
   *   3. operation === 'normal' (discarding during a merge/rebase is dangerous)
   *   4. validatePaths (NUL / absolute / '..' / out-of-snapshot) — defense in
   *      depth on top of the unstaged-set check.
   * Then `git restore --worktree -- <paths>`. Staged changes are preserved
   * (restore --worktree never touches the index). Returns a refreshed status.
   *
   * This is IRREVERSIBLE — the UI MUST show a confirmation dialog naming each
   * file before calling this. The service cannot enforce the dialog, but the
   * fresh-status re-validation ensures the paths the user saw are the paths
   * that get restored.
   */
  async discardWorktreeFiles(repositoryId: string, paths: string[]): Promise<GitStatus> {
    const handle = this.resolve(repositoryId)
    const status = await this.getStatus(repositoryId)
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    // Build the set of paths that are safe to restore: tracked files with
    // worktree changes (the unstaged group). A file that is BOTH staged and
    // unstaged IS allowed here — restore --worktree resets the worktree to the
    // index, preserving the staged version. A file that is ONLY staged (no
    // worktree change) is NOT in the unstaged set → rejected (it has nothing
    // to discard, and we refuse to touch a path the user didn't see as unstaged).
    const unstagedPaths = new Set<string>()
    for (const f of status.unstaged) {
      unstagedPaths.add(f.path)
      if (f.originalPath) unstagedPaths.add(f.originalPath)
    }
    for (const p of paths) {
      if (!unstagedPaths.has(p)) {
        throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', `只能丢弃已跟踪未暂存改动：${p} 不在未暂存列表中`))
      }
    }
    // validatePaths defense-in-depth (NUL / absolute / '..' / snapshot membership).
    const allAllowed = new Set<string>()
    for (const f of [...status.staged, ...status.unstaged, ...status.untracked]) {
      allAllowed.add(f.path)
      if (f.originalPath) allAllowed.add(f.originalPath)
    }
    const safe = validatePaths(paths, allAllowed)
    try {
      await this.runner.restoreWorktree(handle.root, safe)
    } catch (e) {
      throw toGitError(e)
    }
    return this.getStatus(repositoryId)
  }

  /**
   * Collect STAGED-ONLY context for the AI commit-message proposer (Task 4).
   * Closed-service: the renderer passes only `repositoryId`. Returns the built
   * prompt + metadata (excluded/capped paths, totals). The main process then
   * hands the prompt to `AiRuntime.proposeCommitMessage`.
   *
   * Gates (all BEFORE any patch fetch):
   *   1. resolve(repositoryId)
   *   2. fresh getStatus → operation === 'normal' (else MERGE_OR_REBASE_IN_PROGRESS)
   *   3. staged.length > 0 (else NO_STAGED_CHANGES)
   *
   * Per staged file (in snapshot order):
   *   - isSecretPath → excluded (filename + status only; no patch fetched)
   *   - catFileSize HEAD/:0 → binary sniff / too-large → filename + status only
   *   - diffCachedPatch (per-file 80 KiB head cap) → patch text
   *   - isRestrictedContent(patch) → excluded (defense-in-depth on content)
   *
   * Then buildStagedContextPrompt aggregates under 80 KiB / 12,000 lines.
   * Unstaged/untracked files NEVER reach this path — only status.staged is read.
   */
  async collectStagedContext(repositoryId: string): Promise<StagedContextResult> {
    const handle = this.resolve(repositoryId)
    const status = await this.getStatus(repositoryId)
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    if (status.staged.length === 0) {
      throw toGitError(new GitRunnerError('NO_STAGED_CHANGES', '没有已暂存的改动，无法生成提交说明'))
    }

    const files: StagedFileContext[] = []
    for (const f of status.staged) {
      const ctx: StagedFileContext = { path: f.path, status: f.indexStatus || 'M', originalPath: f.originalPath }
      // 1. Secret-path exclusion (no patch fetched at all). Check BOTH the
      //    destination path AND the originalPath for renames/copies — a secret
      //    file renamed to a benign destination (e.g. `secrets/token.json →
      //    data/config.json`) must still be excluded. Only one needs to match.
      if (isSecretPath(f.path) || isSecretPath(f.originalPath ?? '')) {
        ctx.excluded = true
        files.push(ctx)
        continue
      }
      // 2. Binary / too-large pre-check via catFileSize. A staged file has a :0
      //    blob; HEAD blob may be absent (new file). If :0 size > per-file cap,
      //    skip the patch (tooLarge). Binary sniff: fetch the patch then sniff
      //    — but to avoid fetching a huge binary patch, we size-check first.
      const indexSize = await this.runner.catFileSize(handle.root, ':0', f.path)
      if (indexSize !== null && indexSize > 80 * 1024) {
        ctx.tooLarge = true
        files.push(ctx)
        continue
      }
      // 3. Fetch the staged patch (per-file 80 KiB head cap).
      let patch: { text: string; truncated: boolean }
      try {
        patch = await this.runner.diffCachedPatch(handle.root, f.path)
      } catch (e) {
        // A deleted-from-index file or a git error → no patch text; record the
        // file with status only (the proposer still sees it in the file list).
        files.push(ctx)
        continue
      }
      ctx.patch = patch.text
      ctx.truncated = patch.truncated
      // 4. Binary sniff on the patch (git emits "Binary files differ" for binary
      //    blobs; also sniff for NUL in the patch text).
      if (isBinary(patch.text) || /^Binary files /m.test(patch.text)) {
        ctx.binary = true
        ctx.patch = undefined
        files.push(ctx)
        continue
      }
      // 5. Restricted-content exclusion (PEM / .env assignment / AWS keys in
      //    the patch). Defense in depth on top of the path globs.
      if (isRestrictedContent(patch.text)) {
        ctx.excluded = true
        ctx.patch = undefined
      }
      files.push(ctx)
    }

    return buildStagedContextPrompt(files)
  }

  /**
   * Build the compact context needed for a single commit title. Unlike the
   * richer proposal context above, this deliberately does not read or send
   * patch bodies: filenames, index status and `git diff --cached --stat` are
   * sufficient for a one-line title and avoid feeding tens of KiB to a local
   * reasoning model. This keeps generation responsive and also reduces data
   * exposure while remaining strictly staged-only.
   */
  async collectStagedTitleContext(repositoryId: string): Promise<StagedContextResult> {
    const handle = this.resolve(repositoryId)
    const status = await this.getStatus(repositoryId)
    if (status.repository.operation !== 'normal') {
      throw toGitError(new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', `存在进行中的 ${status.repository.operation}，请先完成或中止`))
    }
    if (status.staged.length === 0) {
      throw toGitError(new GitRunnerError('NO_STAGED_CHANGES', '没有已暂存的改动，无法生成提交标题'))
    }

    const excludedPaths = status.staged
      .filter((file) => isSecretPath(file.path) || isSecretPath(file.originalPath ?? ''))
      .map((file) => file.path)
    const fileLines = status.staged.map((file) => {
      const pathLabel = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path
      return `${file.indexStatus || 'M'} ${pathLabel}`
    })
    const stat = await this.runner.diffCachedStat(handle.root)
    const sections = [
      '# Staged changes (staged files only)',
      '## Files',
      fileLines.join('\n'),
      '## Diff stat',
      stat.trim(),
    ]
    let prompt = sections.filter(Boolean).join('\n')
    const maxBytes = 16 * 1024
    let truncated = false
    if (Buffer.byteLength(prompt, 'utf8') > maxBytes) {
      truncated = true
      const lines = prompt.split('\n')
      while (lines.length > 1 && Buffer.byteLength(lines.join('\n'), 'utf8') > maxBytes) lines.pop()
      prompt = lines.join('\n')
    }
    return {
      prompt,
      excludedPaths,
      cappedPaths: [],
      totalBytes: Buffer.byteLength(prompt, 'utf8'),
      totalLines: prompt.split('\n').length,
      truncated,
    }
  }

  /** List recently-used repositories (metadata only; root may no longer exist). */
  listRecent(): GitRecentRepository[] {
    try {
      const raw = readFileSync(this.recentPath, 'utf8')
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.slice(0, MAX_RECENT) : []
    } catch {
      return []
    }
  }

  /** Persist a repository to the recent list (dedup by root, newest first). */
  private async saveRecent(handle: GitRepositoryHandle): Promise<void> {
    try {
      const dir = path.dirname(this.recentPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const entry: GitRecentRepository = {
        root: handle.root,
        displayName: handle.displayName,
        lastOpenedAt: handle.openedAt,
      }
      const rest = this.listRecent().filter((r) => r.root !== handle.root)
      const next = [entry, ...rest].slice(0, MAX_RECENT)
      writeFileSync(this.recentPath, JSON.stringify(next, null, 2), 'utf8')
    } catch {
      // best-effort; never block opening a repo on recent-list persistence
    }
  }

  /**
   * Return the set of repo-relative paths present in the current status
   * snapshot. Used to validate renderer-supplied pathspecs before any write.
   */
  private async allowedPaths(repositoryId: string): Promise<Set<string>> {
    const status = await this.getStatus(repositoryId)
    const all: GitFileChange[] = [...status.staged, ...status.unstaged, ...status.untracked]
    const set = new Set<string>()
    for (const f of all) {
      set.add(f.path)
      if (f.originalPath) set.add(f.originalPath)
    }
    return set
  }
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate renderer-supplied pathspecs against the allow-set. Rejects:
 *   - empty / non-string
 *   - absolute paths (leading '/' or drive letter ':')
 *   - '..' segments (path traversal)
 *   - NUL bytes (command injection via truncation)
 *   - paths not present in the current status snapshot
 * Returns the validated paths. Throws GitRunnerError('REPOSITORY_UNSAFE') on
 * any violation — the renderer cannot smuggle an arbitrary pathspec through.
 */
export function validatePaths(paths: string[], allowed: Set<string>): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '未提供文件路径'))
  }
  const out: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '文件路径为空'))
    }
    if (p.includes('\0')) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '文件路径含非法字符'))
    }
    if (path.isAbsolute(p)) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '不允许绝对路径'))
    }
    // Reject '..' as a path segment (normalize and check).
    const norm = path.normalize(p)
    if (norm.startsWith('..') || norm.includes(`${path.sep}..`)) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', '不允许包含 .. 的路径'))
    }
    if (!allowed.has(p) && !allowed.has(norm)) {
      throw toGitError(new GitRunnerError('REPOSITORY_UNSAFE', `文件不在当前变更列表中：${p}`))
    }
    out.push(p)
  }
  return out
}

// ---------------------------------------------------------------------------
// Operation detection (merge/rebase/cherry-pick/bisect in progress)
// ---------------------------------------------------------------------------

function detectOperation(root: string): GitRepositorySummary['operation'] {
  const gitDir = path.join(root, '.git')
  if (!existsSync(gitDir)) return 'normal'
  if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebase'
  if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(path.join(gitDir, 'BISECT_LOG'))) return 'bisect'
  return 'normal'
}

// ---------------------------------------------------------------------------
// Language hint (for Monaco DiffEditor's language prop)
// ---------------------------------------------------------------------------

/** Map a repo-relative path to a Monaco language id by extension. */
function guessLanguage(rel: string): string | undefined {
  const ext = path.extname(rel).toLowerCase().slice(1)
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', jsonc: 'json',
    md: 'markdown', markdown: 'markdown',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    kt: 'kotlin', scala: 'scala', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
    cc: 'cpp', cs: 'csharp', fs: 'fsharp',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    ini: 'ini', sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', dockerfile: 'dockerfile',
  }
  // Special-case common filenames without useful extensions.
  const base = path.basename(rel).toLowerCase()
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile'
  return map[ext]
}

/**
 * Binary detection mirroring git's heuristic: a blob is binary if it contains
 * a NUL byte in the first 8 KiB. We sniff the decoded text (the diff path
 * already fetched it as utf8; a NUL in the first 8 KiB of the underlying bytes
 * survives utf8 decode as U+0000). Empty strings are not binary.
 */
function isBinary(text: string): boolean {
  if (!text) return false
  const sample = text.length > 8192 ? text.slice(0, 8192) : text
  return sample.indexOf('\0') !== -1
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/** Coerce any thrown value into a GitError (safe message, structured code). */
export function toGitError(e: unknown): GitError {
  if (e instanceof GitRunnerError) {
    return { code: e.code, message: e.message }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { code: 'COMMAND_FAILED', message: msg.slice(0, 400) }
}
