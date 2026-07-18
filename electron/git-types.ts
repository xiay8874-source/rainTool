// Git Workbench shared DTOs.
//
// Types for repository discovery + status + file-level stage/unstage (Task 1),
// diff (Task 2), and commit/fetch/pull/push (Task 3). AI types are added in
// Task 4. All error surfaces carry a safe, redacted message — never the raw
// command line, environment, token, or unbounded stderr.

/** Structured error codes mapped from git exit codes + stderr heuristics. */
export type GitErrorCode =
  | 'GIT_NOT_FOUND'
  | 'NOT_REPOSITORY'
  | 'REPOSITORY_UNSAFE'
  | 'IDENTITY_MISSING'
  | 'NO_STAGED_CHANGES'
  | 'EMPTY_COMMIT'
  | 'MERGE_OR_REBASE_IN_PROGRESS'
  | 'CONFLICT'
  | 'AUTH_REQUIRED'
  | 'REMOTE_DIVERGED'
  | 'HOOK_FAILED'
  | 'COMMAND_TIMEOUT'
  | 'NO_UPSTREAM'
  | 'WORKTREE_DIRTY'
  | 'COMMAND_FAILED'
  // Task 4: AI commit-message proposal errors (provider/schema/availability).
  | 'AI_UNAVAILABLE'
  | 'AI_SCHEMA_INVALID'
  | 'AI_PROVIDER_FAILED'

/** A redacted, user-displayable Git error. Never carries the raw commandline/env/token. */
export interface GitError {
  code: GitErrorCode
  /** Safe, localized diagnostic. Redacted of paths/secrets beyond what the user already sees. */
  message: string
}

/** Repository summary derived from `git status --porcelain=v2 -z --branch`. */
export interface GitRepositorySummary {
  root: string
  displayName: string
  branch: string | null
  headSha: string | null
  upstream: string | null
  ahead: number
  behind: number
  isDetached: boolean
  operation: 'normal' | 'merge' | 'rebase' | 'cherry-pick' | 'bisect'
}

/**
 * A single file change. A path may appear in both staged and unstaged arrays
 * (e.g. staged then further modified); the UI shows both independently.
 * `originalPath` is set on rename entries.
 */
export interface GitFileChange {
  path: string
  /** Index (staged) status char from porcelain v2, e.g. 'A','M','D','R','C'. '' if none. */
  indexStatus: string
  /** Worktree (unstaged) status char, e.g. 'M','D'. '' if none. */
  worktreeStatus: string
  /** Present on rename/copy; the pre-rename path. */
  originalPath?: string
}

/** Full status response: repository summary + the three file groups. */
export interface GitStatus {
  repository: GitRepositorySummary
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
}

/**
 * Diff request. `source` selects which diff to compute:
 *   - staged:   HEAD → index   (git diff --cached -- <path>)
 *   - unstaged: index → worktree (git diff -- <path>)
 *   - untracked: empty → worktree (git diff --no-index /dev/null <path>)
 * `path` is repo-relative and MUST be present in the current status snapshot
 * (the service re-validates before invoking git).
 * `view` is the renderer's preferred rendering ('unified' | 'split'); the
 * service ignores it for blob fetch but echoes it back so the UI can render
 * the requested layout without separate state. Default is 'unified' per plan.
 */
export interface GitDiffRequest {
  repositoryId: string
  path: string
  source: 'staged' | 'unstaged' | 'untracked'
  view?: 'unified' | 'split'
}

/**
 * Diff result. `kind` tells the UI how to render:
 *   - text:     full `original` + `modified` texts; Monaco DiffEditor consumes
 *               them directly (no unified patch, no renderer-side reconstruction)
 *   - binary:   no text; UI shows "二进制文件" placeholder
 *   - too_large: file exceeds the size cap; UI shows "文件过大" + size
 *   - submodule: gitlink; UI shows "子模块" placeholder
 *   - empty:    no changes (e.g. staged-then-reverted); UI shows "无差异"
 *
 * `original`/`modified` are the COMPLETE texts (head-capped only as a safety
 * backstop after the size pre-check). The renderer never parses a patch — it
 * hands these two strings to Monaco's DiffEditor verbatim.
 */
export interface GitDiffResult {
  kind: 'text' | 'binary' | 'too_large' | 'submodule' | 'empty'
  original?: string
  modified?: string
  language?: string
  /** Renderer-requested layout, echoed back so the UI renders split/unified. */
  view?: 'unified' | 'split'
  truncated?: boolean
  summary: string
}

/**
 * The value stored in the repoId → root registry. The repositoryId is an
 * opaque, app-allocated token (`repo_<uuid>`); the renderer never supplies a
 * cwd or root — only this id. Unknown/expired ids are rejected so a stale UI
 * cannot drive a command against a path the user hasn't (re)validated.
 */
export interface GitRepositoryHandle {
  repositoryId: string
  root: string
  displayName: string
  openedAt: number
}

/** Recently-used repository entry persisted to ~/raintool/git-recent-repos.json. */
export interface GitRecentRepository {
  root: string
  displayName: string
  lastOpenedAt: number
}

// ---------------------------------------------------------------------------
// Task 3: commit / fetch / pull / push
// ---------------------------------------------------------------------------

/** Git author identity (read from user.name / user.email; null when unset). */
export interface GitIdentity {
  name: string | null
  email: string | null
}

/** Commit request. `subject` is the single-line title; `body` is the multi-line
 *  description (may be ''). The service validates subject is non-empty after
 *  trim and ≤ 200 chars; body may not contain NUL bytes. */
export interface GitCommitInput {
  repositoryId: string
  subject: string
  body: string
}

/** Commit result: the new HEAD sha + a refreshed status so the renderer updates
 *  the staged count and ahead/behind in one round-trip. */
export interface GitCommitResult {
  headSha: string
  status: GitStatus
}

/** Fetch / pull / push result: a refreshed status (upstream/ahead/behind update)
 *  plus a short redacted human-readable summary. */
export interface GitSyncResult {
  status: GitStatus
  summary: string
}

/**
 * First-push request: the renderer confirms a `(remote, branch)` pair that the
 * MAIN PROCESS proposed (remote from `git remote`, branch from the status
 * snapshot). The service re-validates both before `git push -u <remote> <branch>`.
 * The renderer never invents a remote name — it picks from the list the main
 * process returned via `gitListRemotes`. This closes the silent-origin hole:
 * `push()` rejects NO_UPSTREAM instead of guessing `origin`.
 */
export interface GitPushUpstreamInput {
  repositoryId: string
  /** Remote name, must be present in `git remote` (verified server-side). */
  remote: string
}

/** Result of listing remotes: names + whether the repo has any (for UI gating). */
export interface GitRemoteListResult {
  remotes: string[]
}

/** Local branches available for a safe `git switch`. Remote-only refs are not
 * offered because creating/tracking a branch is a separate, more consequential
 * operation. */
export interface GitBranchListResult {
  branches: string[]
  current: string | null
}

export interface GitSwitchBranchInput {
  repositoryId: string
  /** Must exactly match a local branch returned by gitListBranches. */
  branch: string
}

// ---------------------------------------------------------------------------
// Task 4: AI commit-message proposal DTOs
// ---------------------------------------------------------------------------

/**
 * Request for an AI-generated commit-message proposal. The renderer passes ONLY
 * the opaque `repositoryId` (allocated by the main process) + `modelProfileId`
 * (the active profile from the existing AI store). It never supplies cwd, git
 * argv, paths, or diff text — the main process collects staged context itself
 * via the closed Git service, and reuses the existing configured provider/key.
 */
export interface GitCommitProposalRequest {
  repositoryId: string
  /** Active AI model profile id (from the AI store). Main resolves provider+key. */
  modelProfileId: string
}

/**
 * Result of an AI commit-message proposal. `subject`/`body` populate the
 * existing editable commit inputs (the user reviews + edits before the existing
 * manual Commit button — NEVER auto-commit). `rationale` is shown so the user
 * can judge the proposal. The metadata fields make the redaction/capping
 * transparent in the UI.
 */
export interface GitCommitProposalResult {
  subject: string
  body: string
  rationale: string
  /** Paths excluded (secret-path or restricted-content) — filename + status only. */
  excludedPaths: string[]
  /** Paths dropped because the aggregate 80 KiB / 12,000-line cap was reached. */
  cappedPaths: string[]
  /** Total patch bytes included in the prompt. */
  totalBytes: number
  /** Total patch lines included in the prompt. */
  totalLines: number
  /** True if the aggregate cap was reached (some files dropped to filename-only). */
  truncated: boolean
}
