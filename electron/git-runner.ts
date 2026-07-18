// Git Workbench — closed-operation Git executor (Task 1+2).
//
// Hard encapsulation contract:
//   - There is NO public method that accepts an arbitrary argv. The only way
//     to run git is through the fixed named operations below (revParseTopLevel,
//     revParseHead, statusPorcelainV2, configGet, add, restoreStaged, showBlob,
//     catFileSize). `spawnGit` is a MODULE-LOCAL function — not a class method,
//     not exported — so `runner.runGit` / `runner.spawnGit` are `undefined` at
//     runtime. `reset --hard`, `push --force`, `clean -fd`, `commit`, `fetch`,
//     `merge`, `rebase`, `branch -D` are UNREACHABLE: there is no operation
//     that constructs their argv, and no surface to inject one. This replaces
//     the earlier denylist + public-runGit design (which leaked arbitrary argv).
//
//   - spawn('git', args, { shell: false, cwd: <validated root>,
//     env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }). Never `exec`,
//     never `shell: true`. cwd is always the service-validated repo root —
//     never a renderer value. Pathspecs are always preceded by literal '--'.
//
//   - stdout/stderr are capped (default 16 KiB tail-preserving; blob fetches
//     use a larger head-preserving cap so diff text shows the top of the file).
//     Cancellation is via AbortSignal (no setTimeout+kill); the caller passes
//     the signal and the child is SIGKILLed when it aborts.
//
//   - Errors normalize to GitRunnerError with a redacted message — never the
//     raw commandline/env/token.
//
// The porcelain v2 -z parser + groupFiles are pure exports (no git, no spawn)
// so they can be unit-tested without fixtures.

import { spawn } from 'node:child_process'
import type { GitErrorCode, GitFileChange } from './git-types.js'

/** Default per-command timeout (used only if no AbortSignal is supplied). */
export const GIT_DEFAULT_TIMEOUT_MS = 30_000
/** Per-stream (stdout/stderr) default capture cap. Tail-preserving. */
export const GIT_OUTPUT_CAP_BYTES = 16 * 1024
/** Blob fetch cap for showBlob. Aligned with the service's DIFF_SIZE_CAP_BYTES
 *  (2 MiB) so a blob that passed the size pre-check is fetched in FULL — the
 *  old 256 KiB default silently truncated 257 KiB–2 MiB blobs. The service
 *  passes the exact bounded size when it has one; this is the safety default. */
export const DIFF_BLOB_CAP_BYTES = 2 * 1024 * 1024
/** Per-file staged-patch cap for diffCachedPatch (Task 4 AI commit proposer).
 *  The service aggregates under 80 KiB / 12,000 lines (plan §2.5); this per-file
 *  head cap bounds a single huge patch so it can't blow the aggregate alone. */
export const COMMIT_CONTEXT_CAP_BYTES = 80 * 1024

/** Options accepted by the module-private spawnGit. */
interface SpawnOptions {
  signal?: AbortSignal
  timeoutMs?: number
  stdin?: string
  /** Exit codes that resolve (instead of throw), returning captured stdout. */
  acceptExitCodes?: number[]
  /** Per-stream capture cap in bytes. Default GIT_OUTPUT_CAP_BYTES. */
  cap?: number
  /** 'tail' keeps the last `cap` bytes (errors/status); 'head' keeps the first
   *  `cap` bytes (file/blob text for diff display). Default 'tail'. */
  capMode?: 'tail' | 'head'
}

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
}

/** A normalized Git error. Thrown by the named operations on non-zero exit. */
export class GitRunnerError extends Error {
  readonly code: GitErrorCode
  constructor(code: GitErrorCode, message: string) {
    super(message)
    this.name = 'GitRunnerError'
    this.code = code
  }
}

/**
 * The closed Git executor. One instance is constructed at app-ready and shared
 * across IPC handlers. Every public method is a FIXED named operation with a
 * hand-built argv — there is no generic `runGit(root, args)`. Adding a new git
 * capability requires adding a new named method here (and review), not passing
 * a new argv from a caller.
 */
export class GitRunner {
  /** `git rev-parse --show-toplevel` — canonicalize a candidate repo root. */
  async revParseTopLevel(root: string): Promise<string> {
    const r = await spawnGit(root, ['rev-parse', '--show-toplevel'])
    return r.stdout.trim()
  }

  /** `git rev-parse --verify HEAD` — current commit SHA; null if no commits yet. */
  async revParseHead(root: string): Promise<string | null> {
    try {
      const r = await spawnGit(root, ['rev-parse', '--verify', '-q', 'HEAD'])
      const sha = r.stdout.trim()
      return sha || null
    } catch {
      return null // empty repo / no HEAD
    }
  }

  /** `git status --porcelain=v2 -z --branch` — raw NUL-framed bytes for the parser. */
  async statusPorcelainV2(root: string, signal?: AbortSignal): Promise<Buffer> {
    const r = await spawnGit(root, ['status', '--porcelain=v2', '-z', '--branch'], { signal })
    // stdout was decoded utf8 by the capped buffer; re-encode to recover the
    // NUL framing (NUL is valid utf8 and survives the round-trip).
    return Buffer.from(r.stdout, 'utf8')
  }

  /** `git config --get <key>` — read-only identity; null if unset. */
  async configGet(root: string, key: 'user.name' | 'user.email'): Promise<string | null> {
    try {
      const r = await spawnGit(root, ['config', '--get', key])
      const v = r.stdout.trim()
      return v || null
    } catch (e) {
      // `git config --get` exits 1 when the key is unset → null, not an error.
      if (e instanceof GitRunnerError && e.code === 'COMMAND_FAILED' && /退出码 1/.test(e.message)) return null
      throw e
    }
  }

  /** `git add -- <paths>` — stage. Paths MUST be pre-validated by the service. */
  async add(root: string, paths: string[]): Promise<void> {
    await spawnGit(root, ['add', '--', ...paths])
  }

  /** `git restore --staged -- <paths>` — unstage. */
  async restoreStaged(root: string, paths: string[]): Promise<void> {
    await spawnGit(root, ['restore', '--staged', '--', ...paths])
  }

  /**
   * `git restore --worktree -- <paths>` — discard UNSTAGED worktree changes on
   * TRACKED files only, resetting them to the index version. This never touches
   * the index (staged changes are preserved) and never deletes untracked files.
   * The service pre-validates that every path is a tracked unstaged file in the
   * fresh status snapshot before calling this — untracked paths are rejected
   * upstream (first version offers no delete). Paths MUST be pre-validated.
   */
  async restoreWorktree(root: string, paths: string[]): Promise<void> {
    await spawnGit(root, ['restore', '--worktree', '--', ...paths])
  }

  /**
   * `git diff --cached --stat` — staged-file summary (insertions/deletions per
   * file). Read-only. Used by the AI commit-message proposer's context builder.
   * The service gates on a fresh staged snapshot before calling this.
   */
  async diffCachedStat(root: string, signal?: AbortSignal): Promise<string> {
    const r = await spawnGit(root, ['diff', '--cached', '--stat'], { signal })
    return r.stdout
  }

  /**
   * `git diff --cached --unified=3 --no-ext-diff -- <path>` — one staged file's
   * patch. `path` MUST be pre-validated by the service (fresh staged snapshot +
   * validatePaths). `cap` defaults to COMMIT_CONTEXT_CAP_BYTES (80 KiB head) so
   * a single huge patch is bounded; the service aggregates + enforces the
   * 12,000-line aggregate cap. Returns `{ text, truncated }` so the service can
   * surface a truncation flag. `--no-ext-diff` blocks user diff drivers so the
   * output is always the standard unified format.
   */
  async diffCachedPatch(
    root: string,
    path: string,
    signal?: AbortSignal,
    cap = COMMIT_CONTEXT_CAP_BYTES,
  ): Promise<{ text: string; truncated: boolean }> {
    const r = await spawnGit(root, ['diff', '--cached', '--unified=3', '--no-ext-diff', '--', path], { signal, cap, capMode: 'head' })
    return { text: r.stdout, truncated: r.truncated }
  }

  /**
   * `git show <treeIsh>:<path>` — fetch a blob's text content (head-capped).
   * treeIsh is closed to 'HEAD' (committed version) | ':0' (index/staged
   * version). Throws GitRunnerError('COMMAND_FAILED') if the blob doesn't exist
   * (e.g. HEAD:path for a brand-new file); the caller treats that as empty.
   *
   * `cap` defaults to DIFF_BLOB_CAP_BYTES (2 MiB) — aligned with the service's
   * DIFF_SIZE_CAP_BYTES policy so a blob that passed the size pre-check is
   * fetched in FULL, not silently truncated to a stale 256 KiB default. The
   * service passes the exact bounded size when it has one (from catFileSize).
   * Returns `{ text, truncated }` so the caller can surface a safety-truncation
   * flag if the cap ever binds (e.g. a race grew the blob between the pre-check
   * and the fetch).
   */
  async showBlob(
    root: string,
    treeIsh: 'HEAD' | ':0',
    path: string,
    cap = DIFF_BLOB_CAP_BYTES,
  ): Promise<{ text: string; truncated: boolean }> {
    const r = await spawnGit(root, ['show', `${treeIsh}:${path}`], { cap, capMode: 'head' })
    return { text: r.stdout, truncated: r.truncated }
  }

  /**
   * `git cat-file -s <treeIsh>:<path>` — blob size in bytes; null if missing.
   * Used by the diff service to detect too_large blobs BEFORE fetching them.
   */
  async catFileSize(root: string, treeIsh: 'HEAD' | ':0', path: string): Promise<number | null> {
    try {
      const r = await spawnGit(root, ['cat-file', '-s', `${treeIsh}:${path}`])
      const n = Number.parseInt(r.stdout.trim(), 10)
      return Number.isFinite(n) ? n : null
    } catch {
      return null // blob missing (new file / deleted) → treat as size 0
    }
  }

  // ---- Task 3: commit / fetch / pull / push ----

  /**
   * `git commit -F -` — commit staged files with a message read from stdin.
   * Subject + body are joined (`subject\n\nbody`) and written via opts.stdin so
   * there is no -m argument quoting to worry about. The service gates on
   * identity / staged / operation BEFORE calling this. Hook failures surface
   * as HOOK_FAILED via mapExitToError. Returns stdout (the commit summary).
   */
  async commit(root: string, subject: string, body: string, signal?: AbortSignal): Promise<string> {
    const message = body.trim() ? `${subject}\n\n${body}` : subject
    const r = await spawnGit(root, ['commit', '-F', '-'], { signal, stdin: message })
    return r.stdout
  }

  /** `git fetch --prune` — update remote refs without touching the worktree. */
  async fetch(root: string, signal?: AbortSignal): Promise<void> {
    await spawnGit(root, ['fetch', '--prune'], { signal })
  }

  /**
   * `git pull --ff-only` — fast-forward only; never creates a merge commit.
   * A diverged remote exits non-zero → REMOTE_DIVERGED (via mapExitToError).
   * A missing upstream exits non-zero → the service pre-checks upstream and
   * rejects with NO_UPSTREAM before reaching here.
   */
  async pullFfOnly(root: string, signal?: AbortSignal): Promise<void> {
    await spawnGit(root, ['pull', '--ff-only'], { signal })
  }

  /**
   * `git push` — push the current branch to its CONFIGURED upstream only.
   * The service pre-checks that an upstream is set; if not, it rejects with
   * NO_UPSTREAM and the UI guides the user through an explicit remote/branch
   * confirmation via pushUpstream. This method NEVER silently picks a remote.
   * Non-fast-forward → REMOTE_DIVERGED. Auth failure → AUTH_REQUIRED.
   */
  async push(root: string, signal?: AbortSignal): Promise<void> {
    await spawnGit(root, ['push'], { signal })
  }

  /**
   * `git push -u <remote> <branch>` — first push with explicit tracking setup.
   * BOTH `remote` and `branch` are server-derived: `branch` comes from the
   * status snapshot, `remote` is validated by the service against `git remote`
   * (remoteList) BEFORE this call. The renderer never supplies either string
   * directly to this method — it only confirms a `(remote, branch)` pair the
   * main process proposed. This is a SEPARATE method so plain push() never
   * silently sets tracking on an unexpected remote/branch.
   */
  async pushUpstream(root: string, remote: string, branch: string, signal?: AbortSignal): Promise<void> {
    await spawnGit(root, ['push', '-u', remote, branch], { signal })
  }

  /**
   * `git remote` — list configured remote names (read-only). Used by the
   * service to validate a user-confirmed remote before pushUpstream, so we
   * never spawn `git push -u <arbitrary> <branch>`. Returns the newline-split
   * list (empty array if no remotes). Lines like `origin\turl (fetch)` are
   * trimmed to the first whitespace token (the name).
   */
  async remoteList(root: string, signal?: AbortSignal): Promise<string[]> {
    const r = await spawnGit(root, ['remote'], { signal })
    return r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => n.length > 0)
  }

  /** List local branch names only. The fixed format emits one ref per line. */
  async localBranchList(root: string, signal?: AbortSignal): Promise<string[]> {
    const r = await spawnGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { signal })
    return r.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  }

  /** Switch to an existing local branch. The service first verifies `branch`
   * against localBranchList; `--` prevents a branch name being parsed as an
   * option. Git itself refuses when switching would overwrite local changes. */
  async switchBranch(root: string, branch: string, signal?: AbortSignal): Promise<void> {
    await spawnGit(root, ['switch', '--', branch], { signal })
  }
}

// ---------------------------------------------------------------------------
// Module-private spawn (the SINGLE spawn point; not on the class, not exported)
// ---------------------------------------------------------------------------

/**
 * Spawn git with `shell: false` in `root`. Resolves on exit 0 (or an accepted
 * non-zero code); throws GitRunnerError otherwise. stdout/stderr are capped by
 * a CappedBuffer (tail- or head-preserving per `capMode`). Cancellation is via
 * AbortSignal: when aborted, the child is SIGKILLed and the promise rejects
 * COMMAND_TIMEOUT. This function is module-local — the only callers are the
 * GitRunner named methods above.
 */
function spawnGit(root: string, args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const signal = opts.signal
    const timeoutMs = opts.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS
    const cap = opts.cap ?? GIT_OUTPUT_CAP_BYTES
    const capMode = opts.capMode ?? 'tail'

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, {
        shell: false,
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      reject(new GitRunnerError('GIT_NOT_FOUND', '未找到 git 可执行文件，请确认已安装 Git 并加入 PATH'))
      return
    }

    const stdout = new CappedBuffer(cap, capMode)
    const stderr = new CappedBuffer(cap, capMode)
    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk))

    let settled = false
    const onAbort = () => {
      if (settled) return
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(onAbort, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new GitRunnerError('GIT_NOT_FOUND', '未找到 git 可执行文件，请确认已安装 Git 并加入 PATH'))
      } else {
        reject(new GitRunnerError('COMMAND_FAILED', sanitizeForUser(err.message)))
      }
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      const out = stdout.toString()
      const errText = stderr.toString()
      if (signal?.aborted) {
        reject(new GitRunnerError('COMMAND_TIMEOUT', 'Git 命令已取消（超时或中止）'))
        return
      }
      if (code === 0) {
        resolve({ stdout: out, stderr: errText, exitCode: 0, truncated: stdout.truncated })
        return
      }
      const accept = opts.acceptExitCodes ?? []
      if (code !== null && code < 128 && accept.includes(code)) {
        resolve({ stdout: out, stderr: errText, exitCode: code, truncated: stdout.truncated })
        return
      }
      reject(mapExitToError(code, args[0], errText))
    })

    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
    else child.stdin?.end()
  })
}

// ---------------------------------------------------------------------------
// CappedBuffer: tail- or head-preserving byte cap
// ---------------------------------------------------------------------------

/**
 * A capped byte buffer. In 'tail' mode it keeps the most recent `cap` bytes
 * (ring buffer) — right for error messages, where the cause is at the end. In
 * 'head' mode it keeps the first `cap` bytes and drops the rest — right for
 * file/blob text, where the diff should show the top of the file. `truncated`
 * is true when any bytes were dropped.
 */
class CappedBuffer {
  private readonly cap: number
  private readonly mode: 'tail' | 'head'
  private readonly buf: Buffer
  private write = 0
  private filled = 0
  /** True when any bytes were dropped. Public-read so spawnGit can report it. */
  truncated = false

  constructor(cap: number, mode: 'tail' | 'head') {
    this.cap = cap
    this.mode = mode
    this.buf = Buffer.allocUnsafe(cap)
  }

  append(chunk: Buffer): void {
    if (this.mode === 'head' && this.filled >= this.cap) {
      // Head mode: already full; drop the rest.
      if (chunk.length > 0) this.truncated = true
      return
    }
    let remaining = chunk.length
    let off = 0
    while (remaining > 0) {
      const space = this.cap - this.write
      const take = Math.min(space, remaining)
      chunk.copy(this.buf, this.write, off, off + take)
      this.write = (this.write + take) % this.cap
      off += take
      remaining -= take
      if (this.filled + take > this.cap) this.truncated = true
      this.filled = Math.min(this.filled + take, this.cap)
      if (this.mode === 'head' && this.filled >= this.cap) {
        // Head mode full: drop any remaining bytes in this chunk.
        if (remaining > 0) this.truncated = true
        break
      }
    }
  }

  toString(): string {
    if (!this.truncated) {
      return this.buf.subarray(0, this.filled).toString('utf8')
    }
    if (this.mode === 'head') {
      // Head mode: first `cap` bytes, in order.
      return this.buf.subarray(0, this.filled).toString('utf8')
    }
    // Tail mode: oldest surviving byte is at `write`, wraps to write.
    return Buffer.concat([
      this.buf.subarray(this.write, this.cap),
      this.buf.subarray(0, this.write),
    ]).toString('utf8')
  }
}

// ---------------------------------------------------------------------------
// Error mapping + sanitization
// ---------------------------------------------------------------------------

function mapExitToError(code: number | null, subcommand: string | undefined, stderr: string): GitRunnerError {
  const s = stderr.toLowerCase()
  if (/authentication failed|could not read username|not authorized|403|401/.test(s)) {
    return new GitRunnerError('AUTH_REQUIRED', 'Git 认证失败：请配置 SSH 密钥或 credential helper')
  }
  if (/non-fast-forward|fetch first|diverged|not possible to fast-forward/.test(s)) {
    return new GitRunnerError('REMOTE_DIVERGED', '远端已分叉，请先 Fetch 并处理冲突')
  }
  if (/pre-commit|commit-msg|hook declined|husky/.test(s)) {
    return new GitRunnerError('HOOK_FAILED', 'Git hook 执行失败')
  }
  if (/merge in progress|rebase in progress|cherry-pick in progress/.test(s)) {
    return new GitRunnerError('MERGE_OR_REBASE_IN_PROGRESS', '存在进行中的 merge/rebase，请先完成或中止')
  }
  if (/local changes .* would be overwritten|would be overwritten by (?:checkout|switch)|please commit your changes or stash them/i.test(stderr)) {
    return new GitRunnerError('WORKTREE_DIRTY', '切换会覆盖本地改动，请先提交或处理这些改动')
  }
  // `git commit` with nothing staged (race: staged set emptied between the
  // service's pre-check and the commit) → EMPTY_COMMIT, not COMMAND_FAILED.
  if (subcommand === 'commit' && /nothing to commit|no changes added to commit/.test(s)) {
    return new GitRunnerError('EMPTY_COMMIT', '没有已暂存的改动可提交')
  }
  // `git pull`/`git push` with no upstream configured → NO_UPSTREAM. (The
  // service pre-checks upstream for pull, but push on a branch with no
  // tracking still reaches here; map it cleanly.)
  if ((subcommand === 'pull' || subcommand === 'push') && /no upstream|fatal: the current branch .* has no upstream|fatal: no upstream branch/.test(s)) {
    return new GitRunnerError('NO_UPSTREAM', '当前分支没有配置上游，无法拉取/推送')
  }
  if (code === 128 && /not a git repository|does not appear to be a git repository/.test(s)) {
    return new GitRunnerError('NOT_REPOSITORY', '所选目录不是 Git 仓库')
  }
  if (code === null) {
    return new GitRunnerError('COMMAND_TIMEOUT', `Git 命令超时：${subcommand ?? ''}`)
  }
  return new GitRunnerError('COMMAND_FAILED', `Git 命令失败（${subcommand ?? ''} 退出码 ${code}）`)
}

function sanitizeForUser(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***')
    .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, 'ghp_***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
    .slice(0, 400)
}

// ---------------------------------------------------------------------------
// Porcelain v2 -z parser (pure, exported for unit testing)
// ---------------------------------------------------------------------------

export interface ParsedPorcelainV2 {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  isDetached: boolean
  files: GitFileChange[]
}

/**
 * Parse `git status --porcelain=v2 -z --branch` output (NUL-framed).
 * Under -z, a rename/copy entry ('2 ') is followed by a SECOND NUL frame
 * holding the original path — so we consume the next frame when we see '2 '.
 */
export function parsePorcelainV2(buffer: Buffer): ParsedPorcelainV2 {
  const frames: string[] = []
  let start = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      frames.push(buffer.toString('utf8', start, i))
      start = i + 1
    }
  }
  if (start < buffer.length) frames.push(buffer.toString('utf8', start))

  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let isDetached = false
  const files: GitFileChange[] = []

  for (let i = 0; i < frames.length; i++) {
    const entry = frames[i]
    if (!entry) continue
    if (entry.startsWith('# branch.head ')) {
      const v = entry.slice('# branch.head '.length)
      if (v === '(detached)') { isDetached = true; branch = null } else { branch = v }
      continue
    }
    if (entry.startsWith('# branch.upstream ')) {
      upstream = entry.slice('# branch.upstream '.length)
      continue
    }
    if (entry.startsWith('# branch.ab ')) {
      const m = entry.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
      continue
    }
    if (entry.startsWith('# ')) continue

    if (entry.startsWith('1 ')) {
      const parts = entry.split(' ')
      const xy = parts[1] ?? ''
      const p = parts.slice(8).join(' ')
      if (p) files.push({ path: p, indexStatus: xy[0] ?? '', worktreeStatus: xy[1] ?? '' })
      continue
    }
    if (entry.startsWith('2 ')) {
      const parts = entry.split(' ')
      const xy = parts[1] ?? ''
      const p = parts.slice(9).join(' ')
      const origFrame = frames[i + 1] ?? ''
      i += 1
      if (p) files.push({ path: p, indexStatus: xy[0] ?? '', worktreeStatus: xy[1] ?? '', originalPath: origFrame || undefined })
      continue
    }
    if (entry.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <h1> <h2> <h3> <path>
      // (git omits the worktree mode/sha when the worktree matches stage 3;
      //  verified against real conflicted output: 11 space-separated fields
      //  total, path at index 10 — but it may contain spaces, so join the rest.)
      const parts = entry.split(' ')
      const xy = parts[1] ?? ''
      const p = parts.slice(10).join(' ')
      if (p) files.push({ path: p, indexStatus: xy[0] ?? '', worktreeStatus: xy[1] ?? '' })
      continue
    }
    if (entry.startsWith('? ')) {
      const p = entry.slice(2)
      if (p) files.push({ path: p, indexStatus: '?', worktreeStatus: '' })
      continue
    }
    if (entry.startsWith('! ')) continue
  }

  return { branch, upstream, ahead, behind, isDetached, files }
}

/**
 * Split parsed files into staged / unstaged / untracked groups.
 * - untracked: parsed from '?' (indexStatus '?' at parse) → cleared
 * - staged: indexStatus !== '' && indexStatus !== '.' (HEAD→index changes;
 *   'R' carries originalPath). porcelain v2 uses '.' for "unchanged".
 * - unstaged: worktreeStatus !== '' && worktreeStatus !== '.' (index→worktree;
 *   drops index status). porcelain v2 uses '.' for "unchanged in worktree".
 * A file can appear in both staged and unstaged (staged, then modified again).
 */
export function groupFiles(files: GitFileChange[]): {
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
} {
  const staged: GitFileChange[] = []
  const unstaged: GitFileChange[] = []
  const untracked: GitFileChange[] = []
  for (const f of files) {
    if (f.indexStatus === '?') {
      untracked.push({ ...f, indexStatus: '' })
      continue
    }
    if (f.indexStatus !== '' && f.indexStatus !== '.') staged.push(f)
    if (f.worktreeStatus !== '' && f.worktreeStatus !== '.') {
      unstaged.push({ ...f, indexStatus: '' })
    }
  }
  return { staged, unstaged, untracked }
}
