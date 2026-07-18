// AI commit-message proposer — pure module (no `electron` import, no git spawn).
//
// Task 4: collects STAGED-ONLY diff context under strict caps, excludes
// secret-path / restricted-content files, and validates the model's JSON output
// against a strict zod schema. The runtime calls the provider; this module
// builds the prompt and parses the response. Everything here is pure + unit
// testable without git or electron.
//
// Security invariants (plan §2.5):
//   - Only staged content is ever placed in the prompt (the service gates on
//     fresh getStatus.staged; unstaged/untracked never reach here).
//   - Secret-path files (.env/.pem/.key/id_rsa*/.p12/.keystore/secrets/**) are
//     excluded — filename + status only, never the patch.
//   - Restricted-content files (classifySensitivity: PEM, .env assignments,
//     AWS keys) are ALSO excluded — defense in depth on top of path globs.
//   - Aggregate cap: 32 KiB / 12,000 lines. Overflow files → filename + status.
//   - The model output is strictly zod-validated; on any parse failure the
//     caller fails safe (no partial fill of the commit subject/body).

import { z } from 'zod'
import { classifySensitivity } from './ai-sensitivity-scanner.js'

// ---------------------------------------------------------------------------
// Caps: 32 KiB or 12,000 lines aggregate. A concise title does not need a
// huge prompt; the smaller byte cap materially improves local-model latency.
// ---------------------------------------------------------------------------

/** Aggregate byte cap for the staged context sent to the provider. */
export const COMMIT_CONTEXT_CAP_BYTES = 32 * 1024
/** Aggregate line cap for the staged context. */
export const COMMIT_CONTEXT_CAP_LINES = 12_000
/** Max subject/body/rationale lengths (mirrors the commit gate + reasonable bounds). */
export const PROPOSAL_SUBJECT_MAX = 100
export const PROPOSAL_BODY_MAX = 4000
export const PROPOSAL_RATIONALE_MAX = 1000

// ---------------------------------------------------------------------------
// Secret-path exclusion (plan §2.5)
// ---------------------------------------------------------------------------

/**
 * Returns true if the repo-relative path should be EXCLUDED from the prompt
 * (filename + status only, no patch). Matches the plan's path globs:
 *   - .env (any dir, any case) — but NOT `*.env.d.ts` / `env.d.ts` style config
 *   - *.pem, *.key, *.p12, *.keystore
 *   - id_rsa* (wildcard: id_rsa, id_rsa.pub, id_rsa_backup, id_rsa.work,
 *     id_ed25519, id_ed25519_github, id_ecdsa_sk, id_dsa.old, …) — any file
 *     whose basename starts with `id_rsa`/`id_ed25519`/`id_ecdsa`/`id_dsa`
 *     followed by word chars, dots, or hyphens. OpenSSH key variants are
 *     invariably sensitive; matching the prefix (not just the exact name)
 *     closes the "rename id_rsa → id_rsa.backup" bypass.
 *   - any path under a `secrets/` directory
 *
 * Matching is on the basename for extension checks, and on the full relative
 * path for the `secrets/` segment. Case-insensitive (Windows/SSH key files).
 *
 * NOTE: callers must also check `originalPath` for renames/copies — a secret
 * file renamed to a benign destination must still be excluded. See
 * `collectStagedContext` in git-repository-service.ts.
 */
export function isSecretPath(relPath: string): boolean {
  if (!relPath || typeof relPath !== 'string') return false
  const lower = relPath.toLowerCase()
  const base = lower.split('/').pop() ?? ''
  // `secrets/**` — any path containing a `secrets/` segment.
  if (/(^|\/)secrets\//.test(lower)) return true
  // `.env` exactly, or `*.env` (e.g. `prod.env`, `.env.local`). But NOT
  // `env.d.ts` or `*.env.d.ts` (TypeScript ambient declarations) — those match
  // `env` as a basename prefix, not `.env`/`*.env`.
  if (base === '.env' || /\.env(?:\.[a-z0-9_-]+)?$/.test(base)) return true
  // PEM / private key / cert bundles.
  if (/\.(?:pem|key|p12|keystore)$/.test(base)) return true
  // SSH private/public keys + wildcard variants (id_rsa*, id_ed25519*, …).
  // The `[\w.-]*` tail matches `.pub`, `_backup`, `.work`, `_github`, etc.
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)[\w.-]*$/.test(base)) return true
  return false
}

// ---------------------------------------------------------------------------
// Staged-context prompt builder
// ---------------------------------------------------------------------------

/** Per-file staged context (the service builds this from fresh status + patches). */
export interface StagedFileContext {
  /** Repo-relative path. */
  path: string
  /** porcelain index status char: A/M/D/R/C. */
  status: string
  /** Staged patch text (`git diff --cached --unified=3 -- <path>`). Absent for
   *  excluded/binary/too-large/capped files. */
  patch?: string
  /** True if the patch was truncated by the per-file cap. */
  truncated?: boolean
  /** True if the file is binary (no patch fetched). */
  binary?: boolean
  /** True if the file exceeded the per-file size cap (no patch fetched). */
  tooLarge?: boolean
  /** True if the file was excluded (secret-path or restricted-content). */
  excluded?: boolean
  /** For renames, the pre-rename path. */
  originalPath?: string
}

/** Result of building the staged context prompt. */
export interface StagedContextResult {
  /** The full prompt string to send to the provider. */
  prompt: string
  /** Paths excluded (secret-path or restricted-content) — filename + status only. */
  excludedPaths: string[]
  /** Paths dropped because the aggregate cap was reached — filename + status only. */
  cappedPaths: string[]
  /** Total bytes of the FINAL assembled prompt (headers + list + notes + patches).
   *  Bounded by COMMIT_CONTEXT_CAP_BYTES — the cap bounds the whole outbound
   *  prompt, not just patch text. */
  totalBytes: number
  /** Total lines of the FINAL assembled prompt. Bounded by COMMIT_CONTEXT_CAP_LINES. */
  totalLines: number
  /** True if the aggregate cap was reached (some files dropped to filename-only). */
  truncated: boolean
}

/**
 * Build the status-only note (no patch content) for a file that is excluded,
 * binary, too-large, or has no patch. Returns the note string (with leading
 * newline) or `null` if the file has a real patch and should NOT get a note.
 * A file already marked `cappedPaths` upstream is handled by the caller.
 */
function statusOnlyNote(f: StagedFileContext): string | null {
  const tag = f.originalPath ? `${f.originalPath} → ${f.path}` : f.path
  if (f.excluded) {
    return `\n### ${tag} (${f.status})\n[已排除：敏感文件，仅提供文件名与状态]`
  }
  if (f.binary) {
    return `\n### ${tag} (${f.status})\n[二进制文件，仅提供文件名与状态]`
  }
  if (f.tooLarge) {
    return `\n### ${tag} (${f.status})\n[文件过大，仅提供文件名与状态]`
  }
  if (!f.patch) {
    return `\n### ${tag} (${f.status})\n[无 patch 文本]`
  }
  return null
}

/**
 * Aggregate staged file context under the 32 KiB / 12,000-line cap. The cap
 * bounds the FINAL outbound user prompt — including headers, the file list,
 * status-only notes, paths, AND patch text — not merely the patch bytes. This
 * means thousands of filenames (or thousands of "已排除/二进制" notes) cannot
 * bypass the cap: once the assembled prompt would exceed it, further files are
 * dropped to filename+status only (recorded in `cappedPaths`), and if even the
 * file list itself would overflow, additional list lines are truncated too.
 *
 * Files are added in order; excluded/binary/too-large files always contribute
 * filename + status only. Returns the prompt + metadata.
 *
 * The prompt is a plain-text digest (no JSON escaping) the provider reads. It
 * includes: a header, the file list, then per-file patches (or status-only
 * notes). The model is instructed (via the system prompt, not here) to reply
 * with JSON only.
 */
export function buildStagedContextPrompt(files: StagedFileContext[]): StagedContextResult {
  const excludedPaths: string[] = []
  const cappedPaths: string[] = []
  // totalBytes/totalLines track the FINAL assembled prompt size (headers + list
  // + notes + patches), so the cap bounds what the provider actually receives.
  let totalBytes = 0
  let totalLines = 0
  let truncated = false

  const HEADER = '# 已暂存变更（仅暂存内容，未暂存/未跟踪文件不在其中）'
  // Seed the running totals with the header (always present).
  totalBytes += Buffer.byteLength(HEADER, 'utf8')
  totalLines += HEADER.split('\n').length

  // ---- File list section: filename + status for EVERY file, but cap-bound ----
  // If the list alone would overflow (e.g. thousands of staged files), we stop
  // appending list lines and mark the overflow files as capped. They still
  // appear in the patch section's status-only notes (also cap-bound), so the
  // model at least knows they exist by name — but their patches are never sent.
  const LIST_HEADER = '## 文件列表'
  totalBytes += Buffer.byteLength(LIST_HEADER, 'utf8') + 1 // +1 for the joining newline
  totalLines += 1
  const summaryLines: string[] = []
  for (const f of files) {
    const tag = f.originalPath ? `${f.originalPath} → ${f.path}` : f.path
    const line = `${f.status} ${tag}`
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1 // +1 for newline
    if (totalBytes + lineBytes > COMMIT_CONTEXT_CAP_BYTES || totalLines + 1 > COMMIT_CONTEXT_CAP_LINES) {
      // The file list itself overflowed the cap. Record the overflow file as
      // capped and stop appending list lines. (Its patch will also be skipped
      // in the patch section below via the same cap check.)
      truncated = true
      cappedPaths.push(f.path)
      continue
    }
    totalBytes += lineBytes
    totalLines += 1
    summaryLines.push(line)
  }
  let listSection = LIST_HEADER
  if (summaryLines.length > 0) listSection += '\n' + summaryLines.join('\n')

  // ---- Patch section: per-file patches (or status-only notes), cap-bound ----
  const PATCH_HEADER = '## 已暂存 patch'
  totalBytes += Buffer.byteLength(PATCH_HEADER, 'utf8') + 1
  totalLines += 1
  const patchLines: string[] = []
  for (const f of files) {
    if (f.excluded) {
      excludedPaths.push(f.path)
    }
    // Status-only note (excluded/binary/tooLarge/no-patch/already-capped).
    const note = statusOnlyNote(f)
    if (note) {
      const noteBytes = Buffer.byteLength(note, 'utf8') + 1
      if (totalBytes + noteBytes > COMMIT_CONTEXT_CAP_BYTES || totalLines + note.split('\n').length > COMMIT_CONTEXT_CAP_LINES) {
        // Even the status-only note would overflow → drop entirely, mark capped.
        truncated = true
        if (!excludedPaths.includes(f.path) && !cappedPaths.includes(f.path)) cappedPaths.push(f.path)
        continue
      }
      totalBytes += noteBytes
      totalLines += note.split('\n').length
      patchLines.push(note)
      continue
    }
    // We have a real patch. Check the FINAL-prompt cap BEFORE including it.
    const tag = f.originalPath ? `${f.originalPath} → ${f.path}` : f.path
    const truncTag = f.truncated ? '（已截断）' : ''
    const patchBlock = `\n### ${tag} (${f.status})${truncTag}\n\`\`\`diff\n${f.patch}\n\`\`\``
    const patchBytes = Buffer.byteLength(patchBlock, 'utf8') + 1
    const patchLinesCount = patchBlock.split('\n').length
    if (totalBytes + patchBytes > COMMIT_CONTEXT_CAP_BYTES || totalLines + patchLinesCount > COMMIT_CONTEXT_CAP_LINES) {
      truncated = true
      cappedPaths.push(f.path)
      // Fall back to a status-only note for this file (still cap-bound).
      const fallbackNote = `\n### ${tag} (${f.status})\n[已达聚合上限，仅提供文件名与状态]`
      const fallbackBytes = Buffer.byteLength(fallbackNote, 'utf8') + 1
      if (totalBytes + fallbackBytes <= COMMIT_CONTEXT_CAP_BYTES && totalLines + fallbackNote.split('\n').length <= COMMIT_CONTEXT_CAP_LINES) {
        totalBytes += fallbackBytes
        totalLines += fallbackNote.split('\n').length
        patchLines.push(fallbackNote)
      }
      continue
    }
    totalBytes += patchBytes
    totalLines += patchLinesCount
    patchLines.push(patchBlock)
  }
  let patchSection = PATCH_HEADER
  if (patchLines.length > 0) patchSection += patchLines.join('\n')

  // ---- Assemble the final prompt ----
  const sections: string[] = [HEADER, listSection, patchSection]
  if (truncated) {
    const tail = `\n[注：已达 ${COMMIT_CONTEXT_CAP_BYTES / 1024} KiB / ${COMMIT_CONTEXT_CAP_LINES.toLocaleString()} 行上限，部分文件仅提供文件名与状态]`
    // The tail note is informational; only add it if it fits (it almost always
    // does, since we just dropped files to make room).
    const tailBytes = Buffer.byteLength(tail, 'utf8')
    if (totalBytes + tailBytes <= COMMIT_CONTEXT_CAP_BYTES) {
      sections.push(tail)
    }
  }

  let prompt = sections.join('\n\n')

  // ---- Hard guarantee: the ACTUAL outbound prompt never exceeds either cap ----
  // The running-total accounting above is best-effort (section separators,
  // multi-byte UTF-8 edges, and leading-newline accounting can drift). This
  // final guard measures the REAL assembled string AFTER `sections.join('\n\n')`
  // and enforces BOTH caps on it directly — not on internal counters. This is
  // the security guarantee the cap promises: no accounting drift can make the
  // outbound prompt exceed 32 KiB or 12,000 lines.
  //
  // Approach: trim at COMPLETE LINE boundaries only (never mid-line), and
  // iterate until BOTH caps are satisfied. Each iteration removes trailing
  // lines, so the loop is bounded by the line count. This handles every
  // drift case: byte-trim-then-line-trim ordering bugs, section-separator
  // edges, and the case where a line-trim to 12,000 still leaves >32 KiB
  // (e.g. 12,000 very long lines).
  let guardIters = 0
  for (;;) {
    const actualBytes = Buffer.byteLength(prompt, 'utf8')
    const actualLines = prompt.split('\n').length
    if (actualBytes <= COMMIT_CONTEXT_CAP_BYTES && actualLines <= COMMIT_CONTEXT_CAP_LINES) {
      break
    }
    truncated = true
    // Reduce the line count. If we're over the LINE cap, drop to exactly the
    // cap. If we're under the line cap but over the BYTE cap, drop one line at
    // a time (each line could be up to ~32 KiB, so a single drop is often
    // enough; the loop guarantees termination either way).
    const lines = prompt.split('\n')
    let targetLines: number
    if (actualLines > COMMIT_CONTEXT_CAP_LINES) {
      targetLines = COMMIT_CONTEXT_CAP_LINES
    } else {
      // Over bytes but under lines: shave one line and re-check.
      targetLines = lines.length - 1
    }
    if (targetLines < 1) {
      // Degenerate: even one line exceeds the byte cap. Keep the first line,
      // truncated to the byte boundary (last resort — preserves something
      // useful for the model rather than an empty prompt).
      prompt = lines[0] ?? ''
      const buf = Buffer.from(prompt, 'utf8').subarray(0, COMMIT_CONTEXT_CAP_BYTES)
      prompt = buf.toString('utf8').replace(/\uFFFD$/, '')
      break
    }
    prompt = lines.slice(0, targetLines).join('\n')
    // Safety: the loop must terminate. Each iteration strictly reduces the
    // line count (targetLines < lines.length), so we can't loop forever.
    guardIters++
    if (guardIters > COMMIT_CONTEXT_CAP_LINES + 10) {
      // Defensive bail-out (should be unreachable given the math above).
      prompt = prompt.split('\n').slice(0, COMMIT_CONTEXT_CAP_LINES).join('\n')
      const buf = Buffer.from(prompt, 'utf8').subarray(0, COMMIT_CONTEXT_CAP_BYTES)
      prompt = buf.toString('utf8').replace(/\uFFFD$/, '')
      break
    }
  }

  // Recompute the authoritative totals from the FINAL string — these are what
  // the UI banner reports, so they must reflect reality, not internal counters.
  totalBytes = Buffer.byteLength(prompt, 'utf8')
  totalLines = prompt.split('\n').length

  return {
    prompt,
    excludedPaths,
    cappedPaths,
    totalBytes,
    totalLines,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Commit-proposal schema + tolerant parser
// ---------------------------------------------------------------------------

/** Strict title-only schema. Legacy body/rationale fields are accepted only as
 * empty/optional compatibility fields and normalized away for callers. */
export const CommitProposalSchema = z.object({
  subject: z.string().min(1).max(PROPOSAL_SUBJECT_MAX),
  body: z.string().max(PROPOSAL_BODY_MAX).optional().default(''),
  rationale: z.string().max(PROPOSAL_RATIONALE_MAX).optional().default(''),
}).strict().transform((proposal) => ({ ...proposal, body: '', rationale: '' }))

export type CommitProposal = z.infer<typeof CommitProposalSchema>

function parsePlainSubject(raw: string): { ok: true; proposal: CommitProposal } | { ok: false; reason: string } {
  const plain = raw
    .replace(/^```(?:text|markdown|json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  if (/^(?:抱歉|无法|不能|错误|sorry\b|i\s+(?:cannot|can't)\b|thanks?\b|thank\s+you\b|however\b|it\s+(?:looks|seems)\b)/i.test(plain)
    || /(?:actual\s+diff|diff\s+content|code\s+changes?).{0,40}(?:missing|not\s+(?:included|provided|available))/i.test(plain)) {
    return { ok: false, reason: '模型拒绝或未能生成提交标题' }
  }

  // Local models occasionally return JavaScript-style object literals such
  // as `{subject: "Fix ..."}` or `{'subject': 'Fix ...'}`. Extract the one
  // allowed field instead of failing a long request on JSON syntax alone.
  const objectSubject = plain.match(
    /(?:["']?subject["']?|提交标题|标题)\s*[:：]\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^,}\r\n]+))/i,
  )
  const firstLine = plain.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  const candidate = (objectSubject?.[1] ?? objectSubject?.[2] ?? objectSubject?.[3] ?? firstLine)
    .replace(/^(?:["']?subject["']?|标题|提交标题)\s*[:：]\s*/i, '')
    .replace(/^#+\s*/, '')
    .replace(/^\{\s*/, '')
    .replace(/\s*[,}]\s*$/, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\\(["'])/g, '$1')
    .trim()
  const fallback = CommitProposalSchema.safeParse({ subject: candidate })
  if (!fallback.success) {
    return { ok: false, reason: '模型返回的纯文本提交标题无效' }
  }
  return { ok: true, proposal: fallback.data }
}

/**
 * Parse + validate the model's output. JSON remains the preferred contract,
 * but some otherwise-capable local models ignore the JSON-only instruction
 * and return a conventional commit message as plain text. That form is
 * converted into the same bounded editable proposal instead of making the UI
 * fail after a long inference. Refusal/error prose is still rejected.
 * `{ ok: true, proposal }` or `{ ok: false, reason }`. NEVER throws — the caller
 * fails safe on `{ ok: false }` (no partial fill of the commit subject/body).
 *
 * Tolerant steps:
 *   - Trim surrounding whitespace.
 *   - Strip a single pair of ```json ... ``` or ``` ... ``` fences if present.
 *   - Extract the first balanced `{...}` object if there's leading/trailing prose.
 *   - When there is no JSON object, accept a non-refusal plain-text commit:
 *     first non-empty line = subject; remaining prose is intentionally ignored.
 *   - JSON.parse (catch syntax errors).
 *   - zod safeParse strict (catch schema violations).
 */
export function parseCommitProposal(raw: string): { ok: true; proposal: CommitProposal } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: '模型返回为空' }
  }
  let text = raw.trim()
  // Strip markdown code fences.
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }
  // If there's still prose around the JSON, extract the first balanced object.
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    if (start === -1) {
      return parsePlainSubject(text)
    }
    // Find the matching closing brace (naive but robust for a single object).
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) {
      return { ok: false, reason: '模型返回的 JSON 未闭合' }
    }
    text = text.slice(start, end + 1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return parsePlainSubject(text)
  }
  const result = CommitProposalSchema.safeParse(parsed)
  if (!result.success) {
    const first = result.error.issues[0]
    const reason = first ? `${first.path.join('.')}: ${first.message}` : 'schema 校验失败'
    return { ok: false, reason }
  }
  return { ok: true, proposal: result.data }
}

// ---------------------------------------------------------------------------
// Restricted-content check (wraps classifySensitivity for the proposer's use)
// ---------------------------------------------------------------------------

/**
 * Returns true if the patch text contains restricted content (PEM, .env secret
 * assignment, AWS keys). Used by the service to exclude a file even when its
 * path didn't match `isSecretPath` — defense in depth.
 *
 * Strips per-line diff markers (`+`/`-`/` ` from unified-diff prefix) before
 * scanning, so `+OPENAI_API_KEY=sk-...` in a patch is detected just like the
 * raw `OPENAI_API_KEY=sk-...` assignment would be. Without this, the
 * `^[ \t]*` anchor in classifySensitivity's ENV_SECRET_ASSIGNMENT would miss
 * every added line in a patch (the `+` is not whitespace).
 */
export function isRestrictedContent(patchText: string): boolean {
  if (!patchText) return false
  const stripped = patchText.replace(/^([+\- ])/gm, '')
  return classifySensitivity(stripped).sensitivity === 'restricted'
}
