// P4 RainTool diagram tool adapters.
//
// Adapts specific DiagramRepository operations into AiToolDefinition entries
// with STRICT Zod schemas and APP-OWNED risk mapping (not server labels):
//   - read  : diagram.list / diagram.get / diagram.inspect-revisions
//   - write : diagram.create / diagram.update / diagram.duplicate /
//             diagram.restore-revision  (travel through the P3 approval gate;
//             no execution until a valid approval token is consumed)
//
// EXCLUDED in P4 (not registered): delete, export (png/svg), path-taking or
// other unbounded methods. There is NO arbitrary MCP call IPC — these adapters
// call DiagramRepository directly with validated DTOs. No arbitrary filesystem
// paths are accepted (ids are validated; xml is bounded). There is NO artifact
// apply/writeback shortcut.
//
// The model is never given these tools in P4 (no model tool-calling). They are
// direct-invocation tools (like the JSON tools) reachable in chat mode via the
// explicit directInvocationAllowed gate. Write tools reuse the P3 approval
// workflow: the runtime builds an approval request (buildDiagramApproval),
// awaits decide(), consumes the token, then executes.

import { z } from 'zod'
import type { AiToolDefinition } from './ai-tool-registry.js'
import type { AiToolExecCtx, AiToolResult } from './ai-tool-types.js'
import { canonicalJson, sha256Hex } from './ai-approval-manager.js'
import type { DiagramRepository } from '../diagram-repository.js'
import { DiagramConflictError } from '../diagram-repository.js'
import type {
  DiagramCreateInput,
  DiagramDuplicateInput,
  DiagramUpdateInput,
} from '../diagram-types.js'

const MAX_XML_BYTES = 4 * 1024 * 1024 // 4 MB cap on diagram xml in tool input
// DiagramRepository allocates raw UUIDs (randomUUID). Accept the UUID format
// (hex with hyphens) so a tool caller cannot pass a path or arbitrary id.
const VALID_DIAGRAM_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function xmlMax(): z.ZodString {
  return z.string().max(MAX_XML_BYTES)
}

// ---------------------------------------------------------------------------
// Read tools (risk: read — execute directly, no approval)
// ---------------------------------------------------------------------------

const listSchema = z.object({
  query: z.string().max(200).optional(),
  favorite: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
}).strict()

export function diagramList(repo: DiagramRepository): AiToolDefinition<typeof listSchema> {
  return {
    id: 'diagram.list',
    title: '列出图纸',
    componentId: 'diagram',
    risk: 'read',
    description: '列出 RainTool 图纸元数据（不含 XML），支持搜索/收藏过滤。',
    inputSchema: listSchema,
    execute: (input): AiToolResult => {
      const result = repo.list({
        query: input.query,
        favorite: input.favorite,
        limit: input.limit,
        offset: input.offset,
      })
      const summary = `共 ${result.total} 张图纸（返回 ${result.items.length} 项）`
      const preview = JSON.stringify(result.items.map((m) => ({
        id: m.id, title: m.title, revision: m.revision, updatedAt: m.updatedAt,
      })), null, 2)
      return { ok: true, summary, preview }
    },
  }
}

const getSchema = z.object({
  id: z.string().regex(VALID_DIAGRAM_ID),
}).strict()

export function diagramGet(repo: DiagramRepository): AiToolDefinition<typeof getSchema> {
  return {
    id: 'diagram.get',
    title: '读取图纸',
    componentId: 'diagram',
    risk: 'read',
    description: '按 id 读取一张图纸的完整 XML（只读，不修改）。',
    inputSchema: getSchema,
    execute: (input): AiToolResult => {
      const doc = repo.get(input.id)
      if (!doc) return { ok: false, redactedError: '图纸不存在', category: 'invalid-input' }
      return {
        ok: true,
        summary: `图纸「${doc.title}」(v${doc.revision})`,
        preview: doc.xml.slice(0, 4000),
      }
    },
  }
}

const inspectSchema = z.object({
  id: z.string().regex(VALID_DIAGRAM_ID),
}).strict()

export function diagramInspectRevisions(repo: DiagramRepository): AiToolDefinition<typeof inspectSchema> {
  return {
    id: 'diagram.inspect-revisions',
    title: '查看图纸历史',
    componentId: 'diagram',
    risk: 'read',
    description: '列出图纸的历史版本元数据（只读）。',
    inputSchema: inspectSchema,
    execute: (input): AiToolResult => {
      try {
        const revs = repo.listRevisions(input.id)
        return {
          ok: true,
          summary: `${revs.length} 个历史版本`,
          preview: JSON.stringify(revs, null, 2),
        }
      } catch {
        return { ok: false, redactedError: '图纸不存在', category: 'invalid-input' }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Write tools (risk: write — approval-gated; no execution until token consumed)
// ---------------------------------------------------------------------------

const createSchema = z.object({
  title: z.string().min(1).max(200),
  xml: xmlMax().optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
}).strict()

export function diagramCreate(
  repo: DiagramRepository,
  onChanged?: (document: ReturnType<DiagramRepository['require']>, reason: 'created' | 'updated' | 'duplicated' | 'restored') => void,
): AiToolDefinition<typeof createSchema> {
  return {
    id: 'diagram.create',
    title: '创建图纸（需审批）',
    componentId: 'diagram',
    risk: 'write',
    description: '创建一张新的 RainTool 图纸（写入磁盘，需一次性审批）。',
    inputSchema: createSchema,
    execute: (input): AiToolResult => {
      const createInput: DiagramCreateInput = {
        title: input.title,
        xml: input.xml,
        source: 'raintool',
        tags: input.tags,
      }
      const doc = repo.create(createInput)
      onChanged?.(doc, 'created')
      return {
        ok: true,
        summary: `已创建图纸「${doc.title}」(${doc.id})`,
      }
    },
  }
}

const updateSchema = z.object({
  id: z.string().regex(VALID_DIAGRAM_ID),
  title: z.string().min(1).max(200).optional(),
  xml: xmlMax().optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  favorite: z.boolean().optional(),
  expectedRevision: z.number().int().min(1).optional(),
}).strict()

export function diagramUpdate(
  repo: DiagramRepository,
  onChanged?: (document: ReturnType<DiagramRepository['require']>, reason: 'created' | 'updated' | 'duplicated' | 'restored') => void,
): AiToolDefinition<typeof updateSchema> {
  return {
    id: 'diagram.update',
    title: '更新图纸（需审批）',
    componentId: 'diagram',
    risk: 'write',
    description: '更新图纸的标题/XML/标签/收藏（写入磁盘，需一次性审批；携带 expectedRevision 防冲突）。',
    inputSchema: updateSchema,
    execute: (input): AiToolResult => {
      const updateInput: DiagramUpdateInput = {
        id: input.id,
        title: input.title,
        xml: input.xml,
        tags: input.tags,
        favorite: input.favorite,
        expectedRevision: input.expectedRevision,
      }
      try {
        const doc = repo.update(updateInput)
        onChanged?.(doc, 'updated')
        return {
          ok: true,
          summary: `已更新图纸「${doc.title}」(v${doc.revision})`,
        }
      } catch (e) {
        if (e instanceof DiagramConflictError) {
          return {
            ok: false,
            redactedError: '版本冲突：图纸已被修改，请重新读取后重试',
            category: 'stale-target',
          }
        }
        throw e
      }
    },
  }
}

const duplicateSchema = z.object({
  id: z.string().regex(VALID_DIAGRAM_ID),
  title: z.string().min(1).max(200).optional(),
}).strict()

export function diagramDuplicate(
  repo: DiagramRepository,
  onChanged?: (document: ReturnType<DiagramRepository['require']>, reason: 'created' | 'updated' | 'duplicated' | 'restored') => void,
): AiToolDefinition<typeof duplicateSchema> {
  return {
    id: 'diagram.duplicate',
    title: '复制图纸（需审批）',
    componentId: 'diagram',
    risk: 'write',
    description: '复制一张图纸为新图纸（写入磁盘，需一次性审批）。',
    inputSchema: duplicateSchema,
    execute: (input): AiToolResult => {
      const dupInput: DiagramDuplicateInput = { id: input.id, title: input.title }
      const doc = repo.duplicate(dupInput)
      onChanged?.(doc, 'duplicated')
      return {
        ok: true,
        summary: `已复制为「${doc.title}」(${doc.id})`,
      }
    },
  }
}

const restoreSchema = z.object({
  id: z.string().regex(VALID_DIAGRAM_ID),
  revision: z.number().int().min(1),
  expectedRevision: z.number().int().min(1).optional(),
}).strict()

export function diagramRestoreRevision(
  repo: DiagramRepository,
  onChanged?: (document: ReturnType<DiagramRepository['require']>, reason: 'created' | 'updated' | 'duplicated' | 'restored') => void,
): AiToolDefinition<typeof restoreSchema> {
  return {
    id: 'diagram.restore-revision',
    title: '恢复图纸历史（需审批）',
    componentId: 'diagram',
    risk: 'write',
    description: '将图纸恢复到指定历史版本（写入磁盘，需一次性审批）。',
    inputSchema: restoreSchema,
    execute: (input): AiToolResult => {
      try {
        const doc = repo.restoreRevision(input.id, input.revision, input.expectedRevision)
        onChanged?.(doc, 'restored')
        return {
          ok: true,
          summary: `已恢复「${doc.title}」到 v${doc.revision}`,
        }
      } catch (e) {
        if (e instanceof DiagramConflictError) {
          return { ok: false, redactedError: '版本冲突：图纸已被修改，请重新读取后重试', category: 'stale-target' }
        }
        const msg = (e as Error).message ?? '恢复失败'
        return { ok: false, redactedError: msg.slice(0, 200), category: 'executor-error' }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the P4 diagram tool adapters (read + write) into the registry. */
export function registerDiagramTools(
  registry: import('./ai-tool-registry.js').AiToolRegistry,
  repo: DiagramRepository,
  /**
   * Called after a write tool mutates a diagram (create/update/duplicate/
   * restore), mirroring the diagram-bridge-server's onChanged so the renderer
   * (AI Draw.io tab, diagram management UI) refreshes. Without this, a tool
   * write would persist to disk but the UI would stay stale.
   */
  onChanged?: (document: ReturnType<DiagramRepository['require']>, reason: 'created' | 'updated' | 'duplicated' | 'restored') => void,
): void {
  registry.register(diagramList(repo))
  registry.register(diagramGet(repo))
  registry.register(diagramInspectRevisions(repo))
  registry.register(diagramCreate(repo, onChanged))
  registry.register(diagramUpdate(repo, onChanged))
  registry.register(diagramDuplicate(repo, onChanged))
  registry.register(diagramRestoreRevision(repo, onChanged))
}

/**
 * Build the approval request for a diagram write tool call. Bound to the exact
 * validated input + a diagram target scope. The contentHash is sha256 of the
 * canonical input (what will be written); the revision is sha256 of the target
 * diagram id + expectedRevision (stale-target detection). The runtime calls
 * this for componentId==='diagram' write tools.
 */
export function buildDiagramApproval(
  runId: string,
  toolCallId: string,
  toolId: string,
  input: Record<string, unknown>,
): {
  normalizedInput: string
  targetScope: string
  contentHash: string
  revision: string
  impactSummary: string
  impactPreview: string
} {
  const normalizedInput = canonicalJson(input)
  const targetScope = `diagram:${toolId}`
  // contentHash binds the exact write payload; revision binds the target
  // (diagram id + expectedRevision when present, so a stale-target write is
  // detected if the diagram changed).
  const target = `${input.id ?? ''}:${input.expectedRevision ?? 'latest'}`
  return {
    normalizedInput,
    targetScope,
    contentHash: sha256Hex(normalizedInput),
    revision: sha256Hex(target),
    impactSummary: DIAGRAM_IMPACT[toolId] ?? '图纸写入操作（需审批）',
    // No raw XML in the preview — only a short structural summary. The full
    // payload stays main-process; the approval card shows scope + impact only.
    impactPreview: JSON.stringify(Object.keys(input)),
  }
}

const DIAGRAM_IMPACT: Record<string, string> = {
  'diagram.create': '创建一张新的 RainTool 图纸（写入磁盘）',
  'diagram.update': '更新图纸内容/元数据（写入磁盘；携带版本防冲突）',
  'diagram.duplicate': '复制图纸为新图纸（写入磁盘）',
  'diagram.restore-revision': '将图纸恢复到指定历史版本（写入磁盘）',
}
