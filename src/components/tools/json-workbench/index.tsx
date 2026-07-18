import { useState, useMemo, useRef, useEffect } from 'react'
import type { ToolProps } from '../shared'
import { ActionBtn, CopyBtn } from '../shared'
import { tolerantParse, parseError, repairJson } from './parse'
import { JsonTree } from './JsonTree'
import { JsonDiff } from './JsonDiff'
import { CodeArea, type CodeAreaHandle } from '../CodeArea'
import { FindBar } from '../FindBar'
import { escapeRegExp } from './highlight'
import { useAiStore } from '@/store/ai'

/** Web Crypto sha256 hex (renderer-side revision hash for stale-target check). */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

type Mode = 'tree' | 'diff'

export default function JsonWorkbench({ input, onInput, diffLeft, diffRight, onDiffLeft, onDiffRight }: ToolProps) {
  const [mode, setMode] = useState<Mode>('tree')
  const [indent, setIndent] = useState(2)

  // 对比模式首次进入且 diffLeft 为空时,从树形 input 拷贝一份作初始值(便利)
  useEffect(() => {
    if (mode === 'diff' && diffLeft === undefined && input.trim() && onDiffLeft) {
      onDiffLeft(input)
    }
  }, [mode, diffLeft, input, onDiffLeft])

  const { parsed, error } = useMemo(() => {
    if (!input.trim()) return { parsed: null, error: null }
    try {
      return { parsed: tolerantParse(input), error: null }
    } catch (e) {
      return { parsed: null, error: (e as Error).message }
    }
  }, [input])

  const errInfo = useMemo(() => (error ? parseError(input) : null), [input, error])

  const formatted = useMemo(() => {
    if (!parsed) return ''
    try {
      return JSON.stringify(parsed, null, indent)
    } catch {
      return ''
    }
  }, [parsed, indent])

  // 压缩:无空格无换行,单行输出
  const minified = useMemo(() => {
    if (!parsed) return ''
    try {
      return JSON.stringify(parsed)
    } catch {
      return ''
    }
  }, [parsed])

  const stats = useMemo(() => {
    if (!parsed) return null
    let keys = 0
    let strs = 0
    let nums = 0
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') {
        keys += Object.keys(v).length
        Object.values(v).forEach(walk)
      } else if (typeof v === 'string') strs++
      else if (typeof v === 'number') nums++
    }
    walk(parsed)
    return { keys, strs, nums }
  }, [parsed])

  // 递归转义:把当前输入作为字符串值再编码,可叠加多层(N=1..5)
  // 例如 {"a":"b"} → "{\"a\":\"b\"}" → "\"{\\\"a\\\":\\\"b\\\"}\""
  const [escapeDepth, setEscapeDepth] = useState(1)
  const escape = () => {
    if (!input) return
    let v: string = input
    for (let i = 0; i < escapeDepth; i++) v = JSON.stringify(v)
    onInput(v)
  }
  // 递归反转义:两步合一
  // 1) 外层剥离:反复 JSON.parse 直到结果不再是字符串(或解析失败),还原最外层多重转义
  // 2) 结构内剥离:遍历对象/数组,对「看起来是 JSON 的字符串值」再尝试解析,递归到底
  //    解决 {"payload":"{\"inner\":\"v\"}"} → {"payload":{"inner":"v"}}
  const unescape = () => {
    if (!input) return
    // 步骤1:外层多重转义剥离
    let v: unknown = input
    for (let i = 0; i < 20; i++) {
      if (typeof v !== 'string') break
      try {
        v = JSON.parse(v)
      } catch {
        break
      }
    }
    // 步骤2:结构内递归剥离字符串值
    v = deepUnescape(v)
    if (typeof v === 'string') onInput(v)
    else onInput(JSON.stringify(v, null, indent))
  }

  // 格式化:解析成功直接格式化;失败自动尝试 repairJson,修复成功则用修复结果格式化
  const formatOrRepair = () => {
    if (!input.trim()) return
    try {
      onInput(JSON.stringify(tolerantParse(input), null, indent))
    } catch {
      // 解析失败,尝试修复
      const r = repairJson(input)
      if (r.ok && r.result) {
        try {
          onInput(JSON.stringify(tolerantParse(r.result), null, indent))
        } catch {
          /* 修复后仍无法格式化,保持原样 */
        }
      }
      // 修复失败:不替换输入,由错误提示区展示(用户可点「尝试修复」)
    }
  }

  // 手动尝试修复:替换输入为修复结果
  const tryRepair = () => {
    if (!input.trim()) return
    const r = repairJson(input)
    if (r.ok && r.result) onInput(r.result)
  }

  // P2: attach current JSON SELECTION to the AI Assistant as a context chip.
  // Falls back to the full input ONLY when no text is selected — and the label
  // honestly reflects which one was attached ("选区" vs "全部"). The raw text is
  // sent once via the ingest IPC to the main-process vault; it is never
  // returned to the renderer, logged, or persisted. This is the ONLY way JSON
  // reaches the model — explicit user action, no silent component context.
  const aiStore = useAiStore()
  const [aiMsg, setAiMsg] = useState<string | null>(null)
  const attachToAi = async () => {
    const selection = codeRef.current?.getSelectionText() ?? ''
    const text = selection || input
    if (!text.trim()) return
    const label = selection ? 'JSON 选区' : 'JSON 全部'
    setAiMsg(null)
    try {
      await aiStore.ingestAttachment('json-workbench', label, text)
      setAiMsg(`已附加${label}到 AI 助手`)
    } catch {
      setAiMsg('附加失败')
    }
    setTimeout(() => setAiMsg(null), 2000)
  }

  // P2: generate a repair proposal as a read-only JSON artifact. This NEVER
  // alters the editor text — it creates an artifact the user can preview/copy.
  // No apply/writeback action exists.
  const [proposalMsg, setProposalMsg] = useState<string | null>(null)
  const generateRepairProposal = async () => {
    if (!input.trim()) return
    setProposalMsg(null)
    try {
      const r = repairJson(input)
      if (!r.ok || !r.result) {
        setProposalMsg('无法生成修复提案')
        return
      }
      await window.raintool.aiArtifactCreate({
        kind: 'json',
        title: 'JSON 修复提案',
        content: r.result,
      })
      setProposalMsg('修复提案已生成（只读，可在 Artifacts 查看）')
    } catch {
      setProposalMsg('生成失败')
    }
    setTimeout(() => setProposalMsg(null), 3000)
  }

  // -------------------------------------------------------------------------
  // P3: direct-tool invocation (inspect / propose / apply)
  // -------------------------------------------------------------------------
  // These start a direct-tool run via the store — no model stream, no
  // profile/credential required. The runtime resolves + Zod-validates each
  // call, runs the tool state machine, and emits tool/approval events.
  //
  // The apply button triggers json.apply-proposal-demo (a WRITE tool): the
  // runtime proposes an approval, the ApprovalCard in the AI Assistant renders
  // the approve/reject UI, and on approve the runtime emits an apply-request
  // event. The subscription below handles that event: it checks the current
  // editor revision matches (stale-target detection), applies the proposal via
  // onInput, and acks via aiApplyAck. If the editor changed (revision mismatch),
  // it acks applied:false — the tool fails stale-target, no mutation.

  const [p3Msg, setP3Msg] = useState<string | null>(null)
  const showP3Msg = (msg: string) => {
    setP3Msg(msg)
    setTimeout(() => setP3Msg(null), 3000)
  }

  /** Get the current selection text, falling back to the full input. */
  const selectionOrInput = () => codeRef.current?.getSelectionText() ?? ''
  const effectiveSelection = () => {
    const sel = selectionOrInput()
    return sel.trim() ? sel : input
  }

  const inspectSelection = async () => {
    const selection = effectiveSelection()
    if (!selection.trim()) { showP3Msg('选区为空'); return }
    await aiStore.startToolRun([
      { toolId: 'json.inspect-selection', rawInput: { selection } },
    ])
  }

  const proposeRepair = async () => {
    const selection = effectiveSelection()
    if (!selection.trim()) { showP3Msg('选区为空'); return }
    await aiStore.startToolRun([
      { toolId: 'json.propose-repair', rawInput: { selection } },
    ])
  }

  const applyProposal = async () => {
    // Full-document-only safety rule: the write tool only ever applies a repair
    // built against the COMPLETE editor document. A partial selection is
    // forbidden — it would let the tool bind a revision that does not reflect
    // the live editor input, defeating stale-target detection. If the user has
    // a non-empty selection that differs from the full input, refuse outright
    // and ask them to clear the selection before retrying.
    const selection = selectionOrInput()
    if (selection.trim() && selection !== input) {
      showP3Msg('应用提案仅支持完整 JSON 文档：检测到选区与编辑器内容不一致，请清除选区后重试。')
      return
    }
    if (!input.trim()) { showP3Msg('输入为空'); return }
    // Generate the proposal from the full document (never a selection) so the
    // user sees what will be applied. The tool's executor re-generates it from
    // the validated input; the contentHash binds the exact proposal. The
    // runtime's revision hashes the complete editor input (document), not a
    // selection — so stale-target detection reflects the live editor state.
    const r = repairJson(input)
    if (!r.ok || !r.result) { showP3Msg('无法生成修复提案'); return }
    let proposal = r.result
    try { proposal = JSON.stringify(JSON.parse(r.result), null, 2) } catch { /* keep raw */ }
    await aiStore.startToolRun([
      { toolId: 'json.apply-proposal-demo', rawInput: { document: input, selection: input, proposal } },
    ])
  }

  // P3: subscribe to apply-request events. When the runtime emits an
  // apply-request for a json-workbench:editor-input scope, verify the current
  // editor revision matches the request's revision (stale-target detection).
  // If it matches, apply the proposal via onInput and ack applied:true. If the
  // editor changed (revision mismatch), ack applied:false — no mutation.
  useEffect(() => {
    return window.raintool.onAiRunEvent((event) => {
      if (event.type !== 'apply-request') return
      const p = event.payload
      if (p.targetScope !== 'json-workbench:editor-input') return
      // Compute the current editor revision (sha256 of the current input).
      // The request's revision is sha256 of the complete editor input (document)
      // the proposal was built against — not a selection. If the editor content
      // changed since the proposal, the revision won't match → refuse (applied:false).
      void (async () => {
        const currentRev = await sha256Hex(input)
        if (currentRev !== p.revision) {
          // Stale editor — refuse. The tool fails stale-target; no mutation.
          try {
            await window.raintool.aiApplyAck({
              applyId: p.applyId,
              applied: false,
              targetScope: p.targetScope,
              contentHash: p.contentHash,
              revision: p.revision,
              reason: '编辑器内容已变更，提案过期',
            })
          } catch { /* ack rejected (run may have terminalized) — ignore */ }
          return
        }
        // Revision matches — apply the proposal by replacing the editor input.
        // The proposal already passed sensitivity + hash checks at approval.
        onInput(p.proposal)
        try {
          await window.raintool.aiApplyAck({
            applyId: p.applyId,
            applied: true,
            targetScope: p.targetScope,
            contentHash: p.contentHash,
            revision: p.revision,
          })
        } catch { /* ack rejected — the run may have timed out; ignore */ }
      })()
    })
  }, [input, onInput])

  // ===== 查找/替换(树形模式:作用于输入区 CodeArea,树形做高亮镜像) =====
  const codeRef = useRef<CodeAreaHandle>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  const matchCount = useMemo(() => {
    if (!find) return 0
    try {
      const re = new RegExp(escapeRegExp(find), 'gi')
      return (input.match(re) ?? []).length
    } catch {
      return 0
    }
  }, [find, input])

  // 命中数变化时,把 activeIdx 钳到合法范围
  useEffect(() => {
    if (activeIdx >= matchCount) setActiveIdx(0)
  }, [matchCount, activeIdx])

  // ⌘F 唤起查找栏:仅当本工具可见(树形模式)时响应
  useEffect(() => {
    if (mode !== 'tree') return
    const onFind = () => setFindOpen(true)
    window.addEventListener('raintool:find', onFind)
    return () => window.removeEventListener('raintool:find', onFind)
  }, [mode])

  const gotoMatch = (idx: number) => {
    const matches = codeRef.current?.findMatches(find) ?? []
    if (matches.length === 0) return
    const i = ((idx % matches.length) + matches.length) % matches.length
    const m = matches[i]
    codeRef.current?.selectRange(m.start, m.end)
    setActiveIdx(i)
  }
  const onPrev = () => gotoMatch(activeIdx - 1)
  const onNext = () => gotoMatch(activeIdx + 1)
  const onReplaceNext = () => {
    const matches = codeRef.current?.findMatches(find) ?? []
    if (matches.length === 0) return
    const i = Math.min(activeIdx, matches.length - 1)
    const m = matches[i]
    codeRef.current?.replaceRange(m.start, m.end, replace)
    // 替换后 input 更新 → matchCount 重算;activeIdx 保持,自然指向"下一个"
  }
  const onReplaceAll = () => {
    if (!find) return
    // 字面替换(非正则),一次 onChange → 一个撤销点
    onInput(input.split(find).join(replace))
  }

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 border-b border-line bg-bg-surface px-4 py-2">
        <div className="flex rounded-btn border border-line p-0.5">
          {(['tree', 'diff'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-btn px-2.5 py-0.5 text-caption ${
                mode === m ? 'bg-accent-bg text-accent' : 'text-ink-secondary hover:bg-bg-hover'
              }`}
            >
              {m === 'tree' ? '树形' : '对比'}
            </button>
          ))}
        </div>
        {mode !== 'diff' && (
          <select
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
            className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-secondary outline-none"
          >
            <option value={2}>2 空格</option>
            <option value={4}>4 空格</option>
          </select>
        )}
        {stats && (
          <span className="text-label text-ink-tertiary">
            {stats.keys} 键 · {stats.strs} 字符串 · {stats.nums} 数字
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {mode === 'tree' && <ActionBtn onClick={formatOrRepair}>格式化</ActionBtn>}
          {mode === 'tree' && <ActionBtn onClick={() => onInput(minified)}>压缩</ActionBtn>}
          {mode === 'tree' && (
            <>
              <select
                value={escapeDepth}
                onChange={(e) => setEscapeDepth(Number(e.target.value))}
                title="转义层数"
                className="rounded-btn border border-line bg-bg-surface px-1 py-1 text-caption text-ink-secondary outline-none"
              >
                <option value={1}>×1</option>
                <option value={2}>×2</option>
                <option value={3}>×3</option>
                <option value={4}>×4</option>
                <option value={5}>×5</option>
              </select>
              <ActionBtn onClick={escape}>转义</ActionBtn>
              <ActionBtn onClick={unescape}>反转义</ActionBtn>
            </>
          )}
          {/* P2: attach JSON selection to AI (explicit chip; raw text goes to main-process vault once via ingest) */}
          {mode === 'tree' && <ActionBtn onClick={attachToAi}>附加选区到 AI</ActionBtn>}
          {/* P2: generate repair proposal as read-only artifact (no editor writeback) */}
          {mode === 'tree' && <ActionBtn onClick={generateRepairProposal}>生成修复提案</ActionBtn>}
          {/* P3: direct-tool invocation buttons (inspect/propose/apply). These
              start a direct-tool run via the store — no model stream, no
              profile/credential required. The apply button triggers a write
              tool that needs one-time approval; the ApprovalCard in the AI
              Assistant renders the approve/reject UI. */}
          {mode === 'tree' && <ActionBtn onClick={inspectSelection}>P3 检查选区</ActionBtn>}
          {mode === 'tree' && <ActionBtn onClick={proposeRepair}>P3 修复提案</ActionBtn>}
          {mode === 'tree' && <ActionBtn onClick={applyProposal}>P3 应用提案</ActionBtn>}
          <CopyBtn text={formatted} label="复制" />
        </div>
      </div>

      {/* P2 status messages for AI attach / repair proposal */}
      {aiMsg && (
        <div className="border-b border-line bg-bg-subtle px-4 py-1 text-caption text-ink-secondary">{aiMsg}</div>
      )}
      {proposalMsg && (
        <div className="border-b border-line bg-bg-subtle px-4 py-1 text-caption text-ink-secondary">{proposalMsg}</div>
      )}
      {p3Msg && (
        <div className="border-b border-line bg-bg-subtle px-4 py-1 text-caption text-ink-secondary">{p3Msg}</div>
      )}

      {/* 错误提示 */}
      {errInfo && (
        <div className="flex items-center justify-between border-b border-line bg-bg-subtle px-4 py-1.5 text-caption text-danger">
          <span className="truncate">{errInfo.message}</span>
          <button
            onClick={tryRepair}
            className="ml-2 shrink-0 rounded-btn border border-danger/40 px-1.5 py-0.5 text-caption text-danger hover:bg-danger/10"
          >
            尝试修复
          </button>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex flex-1 overflow-hidden">
        {mode === 'tree' && (
          <div className="flex w-full">
            <div className="relative flex w-1/2 flex-col border-r border-line">
              <div className="border-b border-line px-3 py-1 text-label text-ink-tertiary">输入</div>
              <div className="flex-1">
                <CodeArea
                  ref={codeRef}
                  value={input}
                  onChange={onInput}
                  placeholder="粘贴 JSON(容错:尾逗号、单引号、注释)"
                  search={find}
                />
              </div>
            </div>
            <div className="flex w-1/2 flex-col bg-bg-subtle">
              <div className="border-b border-line px-3 py-1 text-label text-ink-tertiary">树形视图</div>
              <div className="flex-1 overflow-auto p-2">
                {parsed !== null ? (
                  <JsonTree data={parsed} search={find} />
                ) : (
                  <div className="p-3 text-caption text-ink-tertiary">输入有效 JSON 后显示树形</div>
                )}
              </div>
            </div>
            <FindBar
              open={findOpen}
              onClose={() => setFindOpen(false)}
              find={find}
              setFind={(s) => { setFind(s); setActiveIdx(0) }}
              replace={replace}
              setReplace={setReplace}
              matchCount={matchCount}
              activeIndex={activeIdx}
              onPrev={onPrev}
              onNext={onNext}
              onReplaceNext={onReplaceNext}
              onReplaceAll={onReplaceAll}
              canReplace
            />
          </div>
        )}

        {mode === 'diff' && (
          <JsonDiff
            left={diffLeft ?? ''}
            right={diffRight ?? ''}
            onLeft={onDiffLeft ?? (() => {})}
            onRight={onDiffRight ?? (() => {})}
          />
        )}
      </div>
    </div>
  )
}

/**
 * 深度反转义:递归遍历已解析的 JSON 结构,
 * 对「能被 JSON.parse 的字符串值」继续解析,直到不可解析为止。
 * 例如 {"payload":"{\"inner\":\"v\"}"} → {"payload":{"inner":"v"}}
 * 数组与对象均递归处理;数字/布尔/null 不动。
 */
export function deepUnescape(v: unknown): unknown {
  if (typeof v === 'string') {
    // 尝试解析为 JSON;成功则对结果继续递归剥离
    try {
      const parsed = JSON.parse(v)
      return deepUnescape(parsed)
    } catch {
      // 普通字符串(非 JSON),原样返回
      return v
    }
  }
  if (Array.isArray(v)) {
    return v.map(deepUnescape)
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = deepUnescape(val)
    }
    return out
  }
  return v
}
