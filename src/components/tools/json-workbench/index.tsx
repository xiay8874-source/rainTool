import { useState, useMemo, useRef, useEffect } from 'react'
import type { ToolProps } from '../shared'
import { ActionBtn, CopyBtn } from '../shared'
import { tolerantParse, parseError } from './parse'
import { JsonTree } from './JsonTree'
import { JsonDiff } from './JsonDiff'
import { CodeArea, type CodeAreaHandle } from '../CodeArea'
import { FindBar } from '../FindBar'
import { escapeRegExp } from './highlight'

type Mode = 'tree' | 'diff'

export default function JsonWorkbench({ input, onInput }: ToolProps) {
  const [mode, setMode] = useState<Mode>('tree')
  const [indent, setIndent] = useState(2)
  const [diffInput, setDiffInput] = useState('')

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
          {mode === 'tree' && <ActionBtn onClick={() => onInput(formatted)}>格式化</ActionBtn>}
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
          <CopyBtn text={formatted} label="复制" />
        </div>
      </div>

      {/* 错误提示 */}
      {errInfo && (
        <div className="border-b border-line bg-bg-subtle px-4 py-1.5 text-caption text-danger">
          {errInfo.message}
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
          <JsonDiff left={input} right={diffInput} onLeft={onInput} onRight={setDiffInput} />
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
function deepUnescape(v: unknown): unknown {
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
