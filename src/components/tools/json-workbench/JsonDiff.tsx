import { useMemo, useState, useRef, useEffect } from 'react'
import { tolerantParse } from './parse'
import { CodeArea, type CodeAreaHandle } from '../CodeArea'
import { FindBar } from '../FindBar'
import { escapeRegExp, type LineMark } from './highlight'

export function JsonDiff({
  left,
  right,
  onLeft,
  onRight,
}: {
  left: string
  right: string
  onLeft: (v: string) => void
  onRight: (v: string) => void
}) {
  const result = useMemo(() => {
    let l: unknown = null
    let r: unknown = null
    let lErr = ''
    let rErr = ''
    try {
      l = left.trim() ? tolerantParse(left) : null
    } catch (e) {
      lErr = (e as Error).message
    }
    try {
      r = right.trim() ? tolerantParse(right) : null
    } catch (e) {
      rErr = (e as Error).message
    }
    if (lErr || rErr) return { lErr, rErr, rErr2: '', lines: [] as DiffLine[] }
    // 先把两侧格式化为规范两空格缩进,使行级 diff 稳定
    let lf = ''
    let rf = ''
    try {
      lf = l === null ? '' : JSON.stringify(l, null, 2)
      rf = r === null ? '' : JSON.stringify(r, null, 2)
    } catch {
      lf = left
      rf = right
    }
    const { leftMarks, rightMarks, lines } = lineDiff(lf, rf)
    return { lErr, rErr, rErr2: '', lines, lf, rf, leftMarks, rightMarks }
  }, [left, right])

  const diffCount = result.lines.filter((l) => l.status !== 'same').length

  // ===== 查找/替换:跨两侧 CodeArea =====
  const leftRef = useRef<CodeAreaHandle>(null)
  const rightRef = useRef<CodeAreaHandle>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)

  // 两侧各自命中数;导航在合并序列(左全部 + 右全部)里环形
  const leftCount = useMemo(() => countMatches(left, find), [left, find])
  const rightCount = useMemo(() => countMatches(right, find), [right, find])
  const matchCount = leftCount + rightCount

  useEffect(() => {
    if (activeIdx >= matchCount) setActiveIdx(0)
  }, [matchCount, activeIdx])

  // ⌘F 唤起
  useEffect(() => {
    const onFind = () => setFindOpen(true)
    window.addEventListener('raintool:find', onFind)
    return () => window.removeEventListener('raintool:find', onFind)
  }, [])

  /** 给定合并序列里的全局 idx,返回落在哪一侧 + 该侧局部 idx */
  const locate = (idx: number): { side: 'left' | 'right'; local: number } => {
    const i = ((idx % matchCount) + matchCount) % matchCount
    if (i < leftCount) return { side: 'left', local: i }
    return { side: 'right', local: i - leftCount }
  }

  const gotoMatch = (idx: number) => {
    if (matchCount === 0) return
    const { side, local } = locate(idx)
    const ref = side === 'left' ? leftRef : rightRef
    const matches = ref.current?.findMatches(find) ?? []
    const m = matches[local]
    if (m) {
      ref.current?.selectRange(m.start, m.end)
      setActiveIdx(((idx % matchCount) + matchCount) % matchCount)
    }
  }
  const onPrev = () => gotoMatch(activeIdx - 1)
  const onNext = () => gotoMatch(activeIdx + 1)

  const onReplaceNext = () => {
    if (matchCount === 0) return
    const { side, local } = locate(activeIdx)
    const ref = side === 'left' ? leftRef : rightRef
    const matches = ref.current?.findMatches(find) ?? []
    const m = matches[local]
    if (m) ref.current?.replaceRange(m.start, m.end, replace)
  }
  const onReplaceAll = () => {
    if (!find) return
    if (leftCount > 0) onLeft(left.split(find).join(replace))
    if (rightCount > 0) onRight(right.split(find).join(replace))
  }

  // 容错格式化:解析成功则用格式化结果替换输入,失败则原样保留
  const format = (s: string, apply: (v: string) => void) => {
    if (!s.trim()) return
    try {
      apply(JSON.stringify(tolerantParse(s), null, 2))
    } catch {
      /* 解析失败:保持原样 */
    }
  }

  return (
    <div className="relative flex w-full flex-col">
      <div className="flex flex-1">
        {/* JSON A — 左边框用蓝 */}
        <div className="flex w-1/2 flex-col border-r border-line" style={{ borderLeft: '2px solid #2b5cd9' }}>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-1">
            <span className="h-2 w-2 rounded-full" style={{ background: '#2b5cd9' }} />
            <span className="text-label text-ink-tertiary">JSON A</span>
            <button
              onClick={() => format(left, onLeft)}
              className="ml-auto rounded-btn border border-line px-1.5 py-0.5 text-label text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary"
            >
              格式化
            </button>
          </div>
          <div className="flex-1">
            <CodeArea
              ref={leftRef}
              value={left}
              onChange={onLeft}
              placeholder='{"name":"a"}'
              lineMarks={result.leftMarks}
              search={find}
            />
          </div>
        </div>
        {/* JSON B — 左边框用绿 */}
        <div className="flex w-1/2 flex-col" style={{ borderLeft: '2px solid #1a8a47' }}>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-1">
            <span className="h-2 w-2 rounded-full" style={{ background: '#1a8a47' }} />
            <span className="text-label text-ink-tertiary">JSON B</span>
            <button
              onClick={() => format(right, onRight)}
              className="ml-auto rounded-btn border border-line px-1.5 py-0.5 text-label text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary"
            >
              格式化
            </button>
          </div>
          <div className="flex-1">
            <CodeArea
              ref={rightRef}
              value={right}
              onChange={onRight}
              placeholder='{"name":"b"}'
              lineMarks={result.rightMarks}
              search={find}
            />
          </div>
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

      {/* 差异结果:逐行高亮 */}
      <div className="h-48 overflow-auto border-t border-line bg-bg-subtle">
        {(result.lErr || result.rErr) ? (
          <div className="p-2 text-caption text-danger">
            {result.lErr && <div>A 解析错误: {result.lErr}</div>}
            {result.rErr && <div>B 解析错误: {result.rErr}</div>}
          </div>
        ) : diffCount === 0 ? (
          <div className="p-3 text-caption text-ink-tertiary">
            {left.trim() || right.trim() ? '两份 JSON 相同' : '在两侧输入 JSON 进行对比'}
          </div>
        ) : (
          <>
            <div className="sticky top-0 flex items-center justify-between border-b border-line bg-bg-subtle px-3 py-1">
              <span className="text-label text-ink-tertiary">差异 ({diffCount})</span>
              <div className="flex items-center gap-3 text-label">
                <span className="flex items-center gap-1 text-ink-tertiary">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: '#eafaf1', boxShadow: 'inset 0 0 0 2px #1a8a47' }} />
                  新增
                </span>
                <span className="flex items-center gap-1 text-ink-tertiary">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: '#fdeaea', boxShadow: 'inset 0 0 0 2px #d65a5a' }} />
                  删除
                </span>
                <span className="flex items-center gap-1 text-ink-tertiary">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: '#fdf2e0', boxShadow: 'inset 0 0 0 2px #cc6f1a' }} />
                  修改
                </span>
              </div>
            </div>
            {result.lines
              .filter((l) => l.status !== 'same')
              .map((l, i) => (
                <DiffRow key={i} line={l} />
              ))}
          </>
        )}
      </div>
    </div>
  )
}

/** 统计字面量(大小写不敏感)命中数 */
function countMatches(text: string, query: string): number {
  if (!query) return 0
  try {
    const re = new RegExp(escapeRegExp(query), 'gi')
    return (text.match(re) ?? []).length
  } catch {
    return 0
  }
}

function DiffRow({ line }: { line: DiffLine }) {
  // 整行背景色(明快但不刺眼)
  const bg =
    line.status === 'added'
      ? '#eafaf1'
      : line.status === 'removed'
        ? '#fdeaea'
        : '#fdf2e0'

  const marker =
    line.status === 'added' ? '+' : line.status === 'removed' ? '−' : '~'

  const markerColor =
    line.status === 'added'
      ? '#1a8a47'
      : line.status === 'removed'
        ? '#d65a5a'
        : '#cc6f1a'

  return (
    <div
      className="flex items-baseline gap-2 px-3 py-0.5 font-mono text-code"
      style={{ background: bg }}
    >
      <span style={{ color: markerColor }} className="w-3">
        {marker}
      </span>
      <span className="flex-1 truncate text-ink-primary">{line.path}</span>
      {line.status === 'changed' ? (
        <span className="flex items-center gap-1.5">
          <span className="text-danger line-through opacity-70">{line.left}</span>
          <span className="text-ink-tertiary">→</span>
          <DiffValue value={line.right} />
        </span>
      ) : line.status === 'added' ? (
        <DiffValue value={line.right} />
      ) : (
        <span className="text-danger opacity-70">{line.left}</span>
      )}
    </div>
  )
}

// 差异值:按 JSON 值类型上色,让字符串/数字/布尔/null 有视觉区分(与编辑器高亮一致)
function DiffValue({ value }: { value?: string }) {
  if (value === undefined) return null
  const v = value.trim()
  let color = '#1a8a47' // string(含引号或纯文本)
  if (v === 'null') color = '#80868f'
  else if (v === 'true' || v === 'false') color = '#7a3fb0'
  else if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) color = '#cc6f1a'
  else if (v.startsWith('"') || v.startsWith("'")) color = '#1a8a47'
  return <span style={{ color }}>{value}</span>
}

interface DiffLine {
  path: string
  status: 'same' | 'added' | 'removed' | 'changed'
  left?: string
  right?: string
  leftLine?: number
  rightLine?: number
}

/**
 * 行级 diff:把两侧格式化后的文本按行比较,产出两侧各行标记。
 * 用 LCS 简化版(基于 hash 的去重对齐),对 JSON 行级差异足够稳定。
 * 同时产出 path 维度的结构化差异行(供下方结果面板)。
 */
function lineDiff(lf: string, rf: string): {
  leftMarks: Record<number, LineMark>
  rightMarks: Record<number, LineMark>
  lines: DiffLine[]
} {
  const lLines = lf ? lf.split('\n') : []
  const rLines = rf ? rf.split('\n') : []
  const leftMarks: Record<number, LineMark> = {}
  const rightMarks: Record<number, LineMark> = {}

  // LCS dp
  const m = lLines.length
  const n = rLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = lLines[i] === rLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  // 回溯:对齐的行标 same,左侧未对齐标 removed,右侧未对齐标 added
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (lLines[i] === rLines[j]) {
      lines.push({ path: pathOf(lLines[i]), status: 'same', left: lLines[i], right: rLines[j], leftLine: i + 1, rightLine: j + 1 })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      leftMarks[i + 1] = 'removed'
      lines.push({ path: pathOf(lLines[i]), status: 'removed', left: lLines[i], leftLine: i + 1 })
      i++
    } else {
      rightMarks[j + 1] = 'added'
      lines.push({ path: pathOf(rLines[j]), status: 'added', right: rLines[j], rightLine: j + 1 })
      j++
    }
  }
  while (i < m) {
    leftMarks[i + 1] = 'removed'
    lines.push({ path: pathOf(lLines[i]), status: 'removed', left: lLines[i], leftLine: i + 1 })
    i++
  }
  while (j < n) {
    rightMarks[j + 1] = 'added'
    lines.push({ path: pathOf(rLines[j]), status: 'added', right: rLines[j], rightLine: j + 1 })
    j++
  }

  // 把相邻的 removed + added 合并为 changed(同一"key"附近),便于结果面板阅读
  // 简化:仅当连续的 removed 块后紧跟 added 块且行数相同时,合并
  const merged: DiffLine[] = []
  for (let k = 0; k < lines.length; k++) {
    const cur = lines[k]
    const nxt = lines[k + 1]
    if (cur.status === 'removed' && nxt?.status === 'added') {
      merged.push({
        path: cur.path || nxt.path,
        status: 'changed',
        left: cur.left,
        right: nxt.right,
        leftLine: cur.leftLine,
        rightLine: nxt.rightLine,
      })
      // 同时把两侧行标记从 removed/added 改为 changed
      if (cur.leftLine) leftMarks[cur.leftLine] = 'changed'
      if (nxt.rightLine) rightMarks[nxt.rightLine] = 'changed'
      k++
    } else {
      merged.push(cur)
    }
  }

  return { leftMarks, rightMarks, lines: merged }
}

/** 从一行格式化 JSON 文本中粗略提取 key 路径,用于结果面板展示 */
function pathOf(line: string): string {
  const m = line.match(/^\s*"([^"]+)"\s*:/)
  return m ? m[1] : line.trim()
}
