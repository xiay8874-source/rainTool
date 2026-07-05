import { useMemo, useState, useRef, useEffect } from 'react'
import type { ToolProps } from './shared'
import { DualPane, CopyBtn, ActionBtn } from './shared'
import { tolerantParse } from './json-workbench/parse'
import { HighlightedJson, escapeRegExp } from './json-workbench/highlight'
import { FindBar } from './FindBar'

export default function JsonFormat({ input, onInput }: ToolProps) {
  const [indent, setIndent] = useState(2)

  const { formatted, minified, err } = useMemo(() => {
    if (!input.trim()) return { formatted: '', minified: '', err: '' }
    try {
      const obj = tolerantParse(input)
      return {
        formatted: JSON.stringify(obj, null, indent),
        minified: JSON.stringify(obj),
        err: '',
      }
    } catch (e) {
      return { formatted: '', minified: '', err: (e as Error).message }
    }
  }, [input, indent])

  // ===== 查找(只读输出:高亮 + 导航,无替换) =====
  const outputRef = useRef<HTMLPreElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  const fmtCount = useMemo(() => countMatches(formatted, find), [formatted, find])
  const minCount = useMemo(() => countMatches(minified, find), [minified, find])
  const matchCount = fmtCount + minCount

  useEffect(() => {
    if (activeIdx >= matchCount) setActiveIdx(0)
  }, [matchCount, activeIdx])

  // ⌘F 唤起
  useEffect(() => {
    const onFind = () => setFindOpen(true)
    window.addEventListener('raintool:find', onFind)
    return () => window.removeEventListener('raintool:find', onFind)
  }, [])

  const gotoMatch = (idx: number) => {
    if (matchCount === 0) return
    const i = ((idx % matchCount) + matchCount) % matchCount
    const pre = outputRef.current
    if (!pre) return
    // 第 i 个匹配:前 fmtCount 个在 formatted,其余在 minified
    const sep = '\n\n—— 压缩 ——\n'
    const text = formatted + sep + minified
    // 计算第 i 个匹配在合并文本里的偏移
    const re = new RegExp(escapeRegExp(find), 'gi')
    let count = 0
    let m: RegExpExecArray | null
    let targetOffset = -1
    while ((m = re.exec(text)) !== null) {
      if (count === i) { targetOffset = m.index; break }
      count++
      if (m[0].length === 0) re.lastIndex++
    }
    if (targetOffset < 0) return
    // 估算行号 → 滚动(行高 1.6em ≈ 19.2px @ 12px)
    const lineNo = text.slice(0, targetOffset).split('\n').length - 1
    const lineHeight = 19.2
    pre.scrollTop = Math.max(0, lineNo * lineHeight - pre.clientHeight / 2)
    setActiveIdx(i)
  }
  const onPrev = () => gotoMatch(activeIdx - 1)
  const onNext = () => gotoMatch(activeIdx + 1)

  // replace 相关:只读输出,占位(不显示)
  const [replace, setReplace] = useState('')
  const noop = () => {}

  return (
    <div className="relative h-full">
      <DualPane
        inputLabel="输入 JSON"
        outputLabel={err ? '错误' : '格式化 / 压缩'}
        input={input}
        onInput={onInput}
        inputPlaceholder="粘贴 JSON(支持容错:尾逗号、单引号、注释)"
        output={err}
        outputRef={outputRef}
        outputNode={
          err ? (
            <span className="text-danger">{err}</span>
          ) : formatted ? (
            <>
              <HighlightedJson source={formatted} search={find} />
              <span className="text-ink-tertiary">{'\n\n—— 压缩 ——\n'}</span>
              <HighlightedJson source={minified} search={find} />
            </>
          ) : (
            <span className="text-ink-tertiary">—</span>
          )
        }
        actions={
          <>
            <select
              value={indent}
              onChange={(e) => setIndent(Number(e.target.value))}
              className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-secondary outline-none"
            >
              <option value={2}>2 空格</option>
              <option value={4}>4 空格</option>
              <option value={0}>无缩进</option>
            </select>
            <ActionBtn onClick={() => onInput(formatted)}>用格式化结果替换</ActionBtn>
            <CopyBtn text={formatted} label="复制格式化" />
            <CopyBtn text={minified} label="复制压缩" />
          </>
        }
      />
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
        onReplaceNext={noop}
        onReplaceAll={noop}
        canReplace={false}
      />
    </div>
  )
}

/** 统计字面量(大小写不敏感)命中数 */
function countMatches(text: string, query: string): number {
  if (!query || !text) return 0
  try {
    const re = new RegExp(escapeRegExp(query), 'gi')
    return (text.match(re) ?? []).length
  } catch {
    return 0
  }
}
