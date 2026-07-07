import { useMemo, useState, useRef, useEffect } from 'react'
import { tolerantParse, repairJson } from './parse'
import { deepUnescape } from './index'
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

  // 容错格式化:解析成功直接格式化;失败自动尝试 repairJson,修复成功用修复结果格式化
  const format = (s: string, apply: (v: string) => void) => {
    if (!s.trim()) return
    try {
      apply(JSON.stringify(tolerantParse(s), null, 2))
    } catch {
      const r = repairJson(s)
      if (r.ok && r.result) {
        try { apply(JSON.stringify(tolerantParse(r.result), null, 2)) } catch { /* 修复后仍失败,保持原样 */ }
      }
    }
  }

  // 手动修复:替换输入为修复结果
  const repairSide = (s: string, apply: (v: string) => void) => {
    if (!s.trim()) return
    const r = repairJson(s)
    if (r.ok && r.result) apply(r.result)
  }

  // 反转义:外层多重剥离 + 结构内递归剥离(与 JSON 工作台一致)
  const unescape = (s: string, apply: (v: string) => void) => {
    if (!s.trim()) return
    let v: unknown = s
    for (let i = 0; i < 20; i++) {
      if (typeof v !== 'string') break
      try { v = JSON.parse(v) } catch { break }
    }
    v = deepUnescape(v)
    if (typeof v === 'string') apply(v)
    else apply(JSON.stringify(v, null, 2))
  }

  // ===== 同步滚动:两侧 CodeArea 联动(防回环) =====
  const syncing = useRef(false)
  useEffect(() => {
    const unsubL = leftRef.current?.onScroll((top) => {
      if (syncing.current) return
      syncing.current = true
      rightRef.current?.setScrollTop(top)
      syncing.current = false
    })
    const unsubR = rightRef.current?.onScroll((top) => {
      if (syncing.current) return
      syncing.current = true
      leftRef.current?.setScrollTop(top)
      syncing.current = false
    })
    return () => { unsubL?.(); unsubR?.() }
  }, [])

  // 点击 diff 行跳转:removed 跳左,added 跳右,changed 两侧都跳
  const jumpToDiff = (line: DiffLine) => {
    if (line.leftLine) leftRef.current?.scrollToLine(line.leftLine)
    if (line.rightLine) rightRef.current?.scrollToLine(line.rightLine)
  }

  return (
    <div className="relative flex w-full flex-col">
      <div className="flex flex-1">
        {/* JSON A — 左边框用蓝 */}
        <div className="flex flex-1 flex-col" style={{ borderLeft: '2px solid #2b5cd9' }}>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-1">
            <span className="h-2 w-2 rounded-full" style={{ background: '#2b5cd9' }} />
            <span className="text-label text-ink-tertiary">JSON A</span>
            <button
              onClick={() => format(left, onLeft)}
              className="ml-auto rounded-btn border border-line px-1.5 py-0.5 text-label text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary"
            >
              格式化
            </button>
            <button
              onClick={() => unescape(left, onLeft)}
              className="rounded-btn border border-line px-1.5 py-0.5 text-label text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary"
            >
              反转义
            </button>
            {result.lErr && (
              <button
                onClick={() => repairSide(left, onLeft)}
                className="rounded-btn border border-danger/40 px-1.5 py-0.5 text-label text-danger hover:bg-danger/10"
              >
                修复
              </button>
            )}
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

        {/* 中间同步滑动条 */}
        <div
          className="flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-line hover:bg-accent/40"
          title="拖动可同步滚动两侧"
        />

        {/* JSON B — 左边框用绿 */}
        <div className="flex flex-1 flex-col" style={{ borderLeft: '2px solid #1a8a47' }}>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-1">
            <span className="h-2 w-2 rounded-full" style={{ background: '#1a8a47' }} />
            <span className="text-label text-ink-tertiary">JSON B</span>
            <button
              onClick={() => format(right, onRight)}
              className="ml-auto rounded-btn border border-line px-1.5 py-0.5 text-label text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary"
            >
              格式化
            </button>
            <button
              onClick={() => unescape(right, onRight)}
              className="rounded-btn border border-line px-1.5 py-0.5 text-label text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary"
            >
              反转义
            </button>
            {result.rErr && (
              <button
                onClick={() => repairSide(right, onRight)}
                className="rounded-btn border border-danger/40 px-1.5 py-0.5 text-label text-danger hover:bg-danger/10"
              >
                修复
              </button>
            )}
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
          <div className="flex flex-col gap-1 p-2 text-caption text-danger">
            {result.lErr && (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">A 解析错误: {result.lErr}</span>
                <button
                  onClick={() => repairSide(left, onLeft)}
                  className="shrink-0 rounded-btn border border-danger/40 px-1.5 py-0.5 text-caption text-danger hover:bg-danger/10"
                >
                  修复 A
                </button>
              </div>
            )}
            {result.rErr && (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">B 解析错误: {result.rErr}</span>
                <button
                  onClick={() => repairSide(right, onRight)}
                  className="shrink-0 rounded-btn border border-danger/40 px-1.5 py-0.5 text-caption text-danger hover:bg-danger/10"
                >
                  修复 B
                </button>
              </div>
            )}
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
                <DiffRow key={i} line={l} onClick={() => jumpToDiff(l)} />
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

function DiffRow({ line, onClick }: { line: DiffLine; onClick: () => void }) {
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
      onClick={onClick}
      title="点击跳转到对应位置"
      className="flex cursor-pointer items-baseline gap-2 px-3 py-0.5 font-mono text-code hover:brightness-95"
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
