// P3 JSON tools — the three initial built-in tools for the JSON Workbench.
//
//   json.inspect-selection  (read)    — parse/type/path/validation summary; no mutation
//   json.propose-repair     (propose) — produces a repaired JSON preview; no mutation
//   json.apply-proposal-demo (write)  — replace editor input ONLY after approval
//
// The write tool is narrow: it targets `json-workbench:editor-input` only,
// carries a contentHash (what it will write) + revision (source snapshot),
// and its executor calls `ctx.applyToTarget(proposal, revision, targetScope,
// contentHash)`. The runtime owns the cross-process apply flow (apply-request
// event + guarded `ai:apply:ack` IPC); the executor never touches the editor
// directly and NEVER touches files. There is NO module-global apply callback.
//
// All three tools receive their input from the runtime (which Zod-validates
// the renderer's rawInput). The model is never involved — these are direct-
// invocation tools.

import { z } from 'zod'
import type { AiToolDefinition } from './ai-tool-registry.js'
import type { AiToolExecCtx, AiToolResult } from './ai-tool-types.js'
import { canonicalJson, sha256Hex } from './ai-approval-manager.js'

// ---------------------------------------------------------------------------
// Tolerant JSON parse + repair (self-contained; cannot import from src/)
// ---------------------------------------------------------------------------

/** Strict parse; throws on invalid. */
function strictParse(text: string): unknown {
  return JSON.parse(text)
}

/** Tolerant cleanup: comments, single quotes, unquoted keys, trailing commas. */
function cleanup(text: string): string {
  let s = text
  s = s.replace(/\/\/[^\n\r]*/g, '')
  s = s.replace(/\/\*[\s\S]*?\*\//g, '')
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) =>
    '"' + inner.replace(/"/g, '\\"').replace(/\\'/g, "'") + '"',
  )
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, (_m, pre, key, post) =>
    `${pre}"${key}"${post}`,
  )
  s = s.replace(/,\s*([}\]])/g, '$1')
  return s
}

function balanceBrackets(s: string): string {
  let braces = 0
  let brackets = 0
  let inStr = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') braces++
    else if (c === '}') braces--
    else if (c === '[') brackets++
    else if (c === ']') brackets--
  }
  let tail = ''
  for (let i = 0; i < Math.max(0, brackets); i++) tail += ']'
  for (let i = 0; i < Math.max(0, braces); i++) tail += '}'
  return s + tail
}

function repair(text: string): { ok: true; result: string } | { ok: false; error: string } {
  try {
    strictParse(text)
    return { ok: true, result: text }
  } catch { /* continue */ }
  let s = cleanup(text)
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  s = s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
  try {
    strictParse(s)
    return { ok: true, result: s }
  } catch { /* continue */ }
  s = balanceBrackets(s)
  try {
    strictParse(s)
    return { ok: true, result: s }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function rootType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array[${value.length}]`
  if (typeof value === 'object') return `object{${Object.keys(value).length}}`
  return typeof value
}

// ---------------------------------------------------------------------------
// Tool 1: json.inspect-selection (read)
// ---------------------------------------------------------------------------

const inspectSchema = z.object({
  selection: z.string().max(32_000),
}).strict()

export const jsonInspectSelection: AiToolDefinition<typeof inspectSchema> = {
  id: 'json.inspect-selection',
  title: '检查 JSON 选区',
  componentId: 'json-workbench',
  risk: 'read',
  description: '解析 JSON 选区，返回类型/键/校验摘要，不修改任何内容。',
  inputSchema: inspectSchema,
  execute: (input, _ctx): AiToolResult => {
    const text = input.selection
    if (!text.trim()) {
      return { ok: false, redactedError: '选区为空', category: 'invalid-input' }
    }
    try {
      const parsed = strictParse(text)
      const issues: string[] = []
      // Also try tolerant parse to flag tolerable-but-not-strict issues.
      try {
        strictParse(text)
      } catch {
        issues.push('严格解析失败（容错可解析）')
      }
      const summary = `类型：${rootType(parsed)}${issues.length ? '；' + issues.join('；') : ''}`
      return { ok: true, summary, preview: text.slice(0, 4000) }
    } catch (e) {
      const r = repair(text)
      if (r.ok) {
        const parsed = strictParse(r.result)
        return {
          ok: true,
          summary: `严格解析失败，但容错可解析为 ${rootType(parsed)}（修复后需审批才能写入）`,
          preview: r.result.slice(0, 4000),
        }
      }
      return {
        ok: false,
        redactedError: `解析失败：${(e as Error).message.slice(0, 120)}`,
        category: 'executor-error',
      }
    }
  },
}

// ---------------------------------------------------------------------------
// Tool 2: json.propose-repair (propose)
// ---------------------------------------------------------------------------

const proposeSchema = z.object({
  selection: z.string().max(32_000),
}).strict()

export const jsonProposeRepair: AiToolDefinition<typeof proposeSchema> = {
  id: 'json.propose-repair',
  title: '生成 JSON 修复提案',
  componentId: 'json-workbench',
  risk: 'propose',
  description: '生成修复后的 JSON 预览（只读提案），不修改编辑器内容。',
  inputSchema: proposeSchema,
  execute: async (input, ctx): Promise<AiToolResult> => {
    const text = input.selection
    if (!text.trim()) {
      return { ok: false, redactedError: '选区为空', category: 'invalid-input' }
    }
    const r = repair(text)
    if (!r.ok) {
      return {
        ok: false,
        redactedError: `无法生成修复提案：${r.error.slice(0, 120)}`,
        category: 'executor-error',
      }
    }
    // Pretty-print if it parses, so the preview is readable.
    let preview = r.result
    try {
      preview = JSON.stringify(strictParse(r.result), null, 2)
    } catch { /* keep raw */ }
    // Persist the repaired JSON as a read-only proposal artifact (kind=json).
    // The artifact is preview/copy only — NO apply/writeback. The failure
    // contract is NOT best-effort: when the runtime wired a repository
    // (createArtifact defined), a rejected artifact (restricted content,
    // invalid JSON, oversize) MUST surface as tool-failed — never a silent
    // preview-only result with no artifactRef. The repository throws on
    // rejection; we map restricted content → 'restricted-content', anything
    // else → 'executor-error'. The preview-only fallback applies ONLY when no
    // repository is wired (createArtifact undefined).
    let artifactRef: string | undefined
    if (ctx.createArtifact) {
      try {
        artifactRef = await ctx.createArtifact({
          kind: 'json',
          title: 'JSON 修复提案',
          content: preview,
        })
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200)
        const isRestricted = msg.includes('受限内容')
        return {
          ok: false,
          redactedError: isRestricted ? `提案被拒绝：${msg}` : `保存修复提案失败：${msg}`,
          category: isRestricted ? 'restricted-content' : 'executor-error',
        }
      }
    }
    return {
      ok: true,
      summary: '已生成修复提案（只读预览；如需写入编辑器请使用 apply-proposal-demo）',
      preview,
      artifactRef,
    }
  },
}

// ---------------------------------------------------------------------------
// Tool 3: json.apply-proposal-demo (write) — approval-bound, hash-bound, narrow
// ---------------------------------------------------------------------------

const applySchema = z.object({
  selection: z.string().max(32_000),
  proposal: z.string().max(32_000),
  document: z.string().max(32_000),
}).strict()

export const jsonApplyProposalDemo: AiToolDefinition<typeof applySchema> = {
  id: 'json.apply-proposal-demo',
  title: '应用 JSON 修复提案（需审批）',
  componentId: 'json-workbench',
  risk: 'write',
  description: '将修复提案写入 JSON 编辑器（仅替换编辑器输入，不写文件；需一次性审批）。',
  inputSchema: applySchema,
  execute: async (input, ctx): Promise<AiToolResult> => {
    // A partial selection that no longer matches the live document is an
    // invalid input: refuse before touching the target. The runtime has
    // already consumed the approval (consume() passed) before calling
    // execute, but a stale selection must never produce a write.
    if (input.selection !== input.document) {
      return { ok: false, redactedError: '选区与文档不一致', category: 'invalid-input' }
    }
    // The runtime has already consumed the approval (consume() passed) before
    // calling execute. Here we ask the runtime to coordinate the cross-process
    // apply: main emits apply-request, the active trusted renderer applies ONLY
    // if its current editor revision matches, then acks via the guarded
    // ai:apply:ack IPC. The executor never touches the editor directly.
    const targetScope = 'json-workbench:editor-input'
    const revision = sha256Hex(input.document)
    const contentHash = sha256Hex(input.proposal)
    const result = await ctx.applyToTarget(input.proposal, revision, targetScope, contentHash)
    if (!result.ok) {
      return {
        ok: false,
        redactedError: result.reason,
        category: result.category,
      }
    }
    if (!result.applied) {
      return {
        ok: false,
        redactedError: '应用未执行（目标可能已变更）',
        category: 'stale-target',
      }
    }
    return {
      ok: true,
      summary: '已将修复提案应用到 JSON 编辑器输入',
    }
  },
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

import type { AiToolRegistry } from './ai-tool-registry.js'

export function registerJsonTools(registry: AiToolRegistry): void {
  registry.register(jsonInspectSelection)
  registry.register(jsonProposeRepair)
  registry.register(jsonApplyProposalDemo)
}

/**
 * Build the approval request for a write tool call. The runtime calls this to
 * create the proposal bound to the exact input + target. The contentHash is
 * the sha256 of what will be written; the revision is the sha256 of the
 * source/target snapshot (stale-target detection).
 */
export function buildJsonApplyApproval(
  runId: string,
  toolCallId: string,
  input: { selection: string; proposal: string; document: string },
): {
  normalizedInput: string
  targetScope: string
  contentHash: string
  revision: string
  impactSummary: string
  impactPreview: string
} {
  // A partial selection that no longer matches the live document must not even
  // create an approval — reject before building any approval fields. Uses the
  // same Chinese error as the executor's invalid-input guard.
  if (input.selection !== input.document) {
    throw new Error('选区与文档不一致')
  }
  return {
    normalizedInput: canonicalJson(input),
    targetScope: 'json-workbench:editor-input',
    contentHash: sha256Hex(input.proposal),
    revision: sha256Hex(input.document),
    impactSummary: '将修复提案写入 JSON 编辑器输入（替换全部内容）',
    impactPreview: input.proposal.slice(0, 4000),
  }
}
