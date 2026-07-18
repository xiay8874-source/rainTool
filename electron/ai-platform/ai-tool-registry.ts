// P3 Tool Registry — main-process, allowlisted + Zod-validated tools.
//
// Every tool is registered here with a stable id, a Zod input schema, and a
// main-process executor. The registry NEVER executes tools — it only resolves
// + validates input. Execution is the runtime's job, gated by approval for
// `write` risk. No model-generated code/command may execute: only registered
// executors receive validated DTOs.
//
// `resolve(id, rawInput, mode, profile)` is the single validation chokepoint:
//   1. allowlist lookup (unregistered id → rejected)
//   2. mode/risk capability check via toolsForMode (§8.5)
//   3. Zod safeParse with strict (unknown fields → rejected, §8.7)
// The parsed DTO is returned to the runtime; rawInput is discarded.
//
// Tool results are sanitized (redactSecrets + classifySensitivity) by the
// runtime before they cross to the renderer/audit — see sanitizeToolText.

import { z, type ZodTypeAny } from 'zod'
import type { AiModelProfile, AiRunMode, AiToolRisk } from './ai-types.js'
import { redactSecrets } from './ai-provider-registry.js'
import { classifySensitivity } from './ai-sensitivity-scanner.js'
import {
  type AiComponentId,
  type AiToolErrorCategory,
  type AiToolExecCtx,
  type AiToolId,
  type AiToolMeta,
  type AiToolResult,
  directInvocationAllowed,
  toolsForMode,
} from './ai-tool-types.js'

/**
 * A registered tool. `execute` is main-process-only and never crosses IPC.
 * The executor receives the Zod-parsed DTO + a context with emit (for
 * tool-started/tool-completed/tool-failed) — never keys/credentials.
 */
export interface AiToolDefinition<T extends ZodTypeAny = ZodTypeAny> {
  id: AiToolId
  title: string
  componentId: AiComponentId
  risk: AiToolRisk
  description: string
  inputSchema: T
  execute: (
    input: z.infer<T>,
    ctx: AiToolExecCtx,
  ) => AiToolResult | Promise<AiToolResult>
}

export type AiToolResolved<T = unknown> = {
  ok: true
  tool: AiToolDefinition
  input: T
}
export type AiToolResolveFailure = {
  ok: false
  reason: string
  category: AiToolErrorCategory
}
export type AiToolResolveResult = AiToolResolved | AiToolResolveFailure

export class AiToolRegistry {
  private readonly tools = new Map<AiToolId, AiToolDefinition>()

  register<T extends ZodTypeAny>(def: AiToolDefinition<T>): void {
    if (this.tools.has(def.id)) {
      throw new Error(`tool already registered: ${def.id}`)
    }
    this.tools.set(def.id, def as unknown as AiToolDefinition)
  }

  /** Metadata only — safe for the renderer. Never exposes executors. */
  list(): AiToolMeta[] {
    return [...this.tools.values()].map((t) => ({
      id: t.id,
      title: t.title,
      componentId: t.componentId,
      risk: t.risk,
      description: t.description,
    }))
  }

  get(id: AiToolId): AiToolDefinition | null {
    return this.tools.get(id) ?? null
  }

  /**
   * Resolve + validate a tool call. The single chokepoint before execution.
   * Returns the parsed DTO on success; a safe reason + category on failure.
   * Never executes — the runtime does that after the approval gate (if any).
   *
   * `direct` selects the capability gate (correction 4):
   *   - true  → directInvocationAllowed (P3 renderer/test-explicit path;
   *             reachable in chat mode; never model tools)
   *   - false → toolsForMode (future model-initiated tool calling; chat → 0)
   */
  resolve(
    id: AiToolId,
    rawInput: unknown,
    mode: AiRunMode,
    profile: AiModelProfile,
    direct: boolean,
  ): AiToolResolveResult {
    const tool = this.tools.get(id)
    if (!tool) {
      return {
        ok: false,
        reason: `未注册的工具：${id}`,
        category: 'invalid-input',
      }
    }
    // Capability gate. Direct invocation uses directInvocationAllowed (P3
    // explicit path, reachable in chat). Model tool calling would use
    // toolsForMode (future; chat → 0 tools). A tool whose risk is not allowed
    // is rejected.
    const allowed = direct
      ? directInvocationAllowed(mode, profile.capabilities.toolCalling)
      : toolsForMode(mode, profile.capabilities.toolCalling)
    if (!allowed.has(tool.risk)) {
      return {
        ok: false,
        reason: `当前模式不允许该工具风险等级（${tool.risk}）`,
        category: 'invalid-input',
      }
    }
    // §8.7: Zod strict parse — unknown fields / wrong types rejected before
    // the executor runs. The model/renderer gets a short factual error.
    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const msg = first
        ? `${first.path.join('.') || 'input'}: ${first.message}`
        : '输入校验失败'
      return {
        ok: false,
        reason: sanitizeToolText(msg).slice(0, 200),
        category: 'invalid-input',
      }
    }
    return { ok: true, tool, input: parsed.data }
  }
}

/**
 * Sanitize a tool text field (summary/preview/error) before it crosses to the
 * renderer or the audit log. Restricted content (PEM/.env/AWS) is blocked:
 * the field is replaced with a safe reason. Residual secrets (sk-…/Bearer/long
 * base64) are stripped via redactSecrets as defense-in-depth. The result is
 * truncated to a safe length.
 */
export function sanitizeToolText(text: string, maxLen = 1000): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  const sens = classifySensitivity(text)
  if (sens.sensitivity === 'restricted') {
    return `[受限内容已省略：${sens.reason}]`
  }
  return redactSecrets(text).slice(0, maxLen)
}

/**
 * Sanitize a whole tool result: each text field is redacted + sensitivity-
 * checked. A restricted result is converted to a safe failure (no payload
 * crosses to the renderer/audit).
 */
export function sanitizeToolResult(result: AiToolResult): AiToolResult {
  if (result.ok) {
    const summary = sanitizeToolText(result.summary, 200)
    const preview = result.preview ? sanitizeToolText(result.preview, 4000) : undefined
    if (summary === '' || summary.startsWith('[受限内容已省略')) {
      return {
        ok: false,
        redactedError: summary || '工具结果含受限内容，已阻止',
        category: 'restricted-content',
      }
    }
    return { ok: true, summary, preview, artifactRef: result.artifactRef }
  }
  return {
    ok: false,
    redactedError: sanitizeToolText(result.redactedError, 300),
    category: result.category,
  }
}
