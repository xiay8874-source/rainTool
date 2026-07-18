import { useRef, useEffect, useImperativeHandle, forwardRef, type ChangeEvent } from 'react'
import { HighlightedJson, escapeRegExp, type LineMark } from './json-workbench/highlight'

/**
 * 带语法高亮的可编辑代码框。
 * 实现:textarea(透明文字,接收输入)叠在 pre(高亮渲染)之上,
 * 两者字号/行高/padding 完全一致,滚动同步。
 *
 * 受控 textarea 会破坏浏览器原生撤销栈(value 被 React 覆盖),
 * 因此自建撤销/重做历史栈,支持:
 *   Ctrl/Cmd+Z  撤销
 *   Ctrl/Cmd+Shift+Z / Ctrl+Y  重做
 *   Ctrl/Cmd+A  全选(原生)
 *   Ctrl/Cmd+C/X/V 复制/剪切/粘贴(原生)
 *
 * 可选 lineMarks:diff 模式下按行号标记差异行。
 * 可选 search:匹配段黄底高亮。
 *
 * 通过 ref 暴露命令式 API(查找/替换/导航):
 *   focus() / getValue() / findMatches(q) / selectRange(s,e) / replaceRange(s,e,t)
 */
export interface CodeAreaHandle {
  focus(): void
  getValue(): string
  /** 在当前值里查找所有匹配(大小写不敏感,字面量),返回起止偏移数组 */
  findMatches(query: string): { start: number; end: number }[]
  /** 选中 [start,end) 并滚动到可视区 */
  selectRange(start: number, end: number): void
  /** 替换 [start,end) 为 text,触发 onChange(进入撤销栈) */
  replaceRange(start: number, end: number, text: string): void
  /** 滚动到指定行(1 起始),居中显示 */
  scrollToLine(line: number): void
  /** 获取当前 scrollTop(用于同步滚动) */
  getScrollTop(): number
  /** 设置 scrollTop(用于同步滚动),同步 pre 高亮层 */
  setScrollTop(v: number): void
  /** 订阅滚动事件,返回取消订阅函数 */
  onScroll(cb: (scrollTop: number) => void): () => void
  /** P2: 返回当前选中的文本(无选中返回空串),用于 JSON Workbench 附加选区到 AI */
  getSelectionText(): string
}

export const CodeArea = forwardRef<CodeAreaHandle, {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  lineMarks?: Record<number, LineMark>
  search?: string
}>(function CodeArea({
  value,
  onChange,
  placeholder,
  autoFocus,
  lineMarks,
  search,
}, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  // 撤销/重做栈
  const history = useRef<string[]>([value])
  const hIdx = useRef(0)
  // 标记:本次 onChange 是由 undo/redo 触发的,不要入栈
  const skipPush = useRef(false)
  // 外部滚动订阅(用于 JsonDiff 两侧同步滚动)
  const scrollCallbacks = useRef<Set<(top: number) => void>>(new Set())

  // 外部重置(如程序化 onInput 格式化/压缩):若值与栈顶不同且非 undo 引起,入栈
  useEffect(() => {
    if (skipPush.current) {
      skipPush.current = false
      return
    }
    if (value !== history.current[hIdx.current]) {
      // 截断 redo 分支
      history.current = history.current.slice(0, hIdx.current + 1)
      history.current.push(value)
      // 限制历史长度,避免内存膨胀
      if (history.current.length > 200) history.current.shift()
      else hIdx.current = history.current.length - 1
    }
  }, [value])

  // 同步滚动:textarea 滚动时,pre 跟随,并通知外部订阅者(同步滚动)
  const syncScroll = () => {
    const ta = taRef.current
    const pre = preRef.current
    if (!ta || !pre) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
    // 通知外部 onScroll 订阅者
    scrollCallbacks.current.forEach((cb) => cb(ta.scrollTop))
  }

  useEffect(() => {
    syncScroll()
  }, [value])

  const handle = (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)

  const doUndo = () => {
    if (hIdx.current > 0) {
      hIdx.current--
      skipPush.current = true
      onChange(history.current[hIdx.current])
    }
  }
  const doRedo = () => {
    if (hIdx.current < history.current.length - 1) {
      hIdx.current++
      skipPush.current = true
      onChange(history.current[hIdx.current])
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault()
      doUndo()
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault()
      doRedo()
    }
    // Ctrl/Cmd+A/C/V/X 交给浏览器原生处理
  }

  // 命令式 API:供 FindBar 查找/替换/导航使用
  useImperativeHandle(ref, () => ({
    focus() {
      taRef.current?.focus()
    },
    getValue() {
      return value
    },
    findMatches(query: string) {
      if (!query) return []
      const re = new RegExp(escapeRegExp(query), 'gi')
      const out: { start: number; end: number }[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(value)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length })
        if (m[0].length === 0) re.lastIndex++ // 避免零宽死循环
      }
      return out
    },
    selectRange(start: number, end: number) {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(start, end)
      // 把选区滚进可视区:用 setSelectionRange 后,调用 blur+focus 不靠谱,
      // 这里手动按行高估算滚动位置(行高 1.6em,字号 12px → 约 19.2px)
      const lineHeight = 19.2
      // 找到 start 所在行号
      const lineNo = value.slice(0, start).split('\n').length - 1
      const targetTop = lineNo * lineHeight
      const viewH = ta.clientHeight
      // 若选区不在可视区,滚动让其居中
      if (targetTop < ta.scrollTop || targetTop > ta.scrollTop + viewH - lineHeight) {
        ta.scrollTop = Math.max(0, targetTop - viewH / 2)
        syncScroll()
      }
    },
    replaceRange(start: number, end: number, text: string) {
      const next = value.slice(0, start) + text + value.slice(end)
      onChange(next)
    },
    scrollToLine(line: number) {
      const ta = taRef.current
      if (!ta || line < 1) return
      const lineHeight = 19.2
      const targetTop = (line - 1) * lineHeight
      const viewH = ta.clientHeight
      // 居中显示
      if (targetTop < ta.scrollTop || targetTop > ta.scrollTop + viewH - lineHeight) {
        ta.scrollTop = Math.max(0, targetTop - viewH / 2)
        syncScroll()
      }
    },
    getScrollTop() {
      return taRef.current?.scrollTop ?? 0
    },
    setScrollTop(v: number) {
      const ta = taRef.current
      if (!ta) return
      ta.scrollTop = v
      syncScroll()
    },
    onScroll(cb: (scrollTop: number) => void) {
      scrollCallbacks.current.add(cb)
      return () => { scrollCallbacks.current.delete(cb) }
    },
    getSelectionText() {
      const ta = taRef.current
      if (!ta) return ''
      const { selectionStart, selectionEnd } = ta
      if (selectionStart === selectionEnd) return ''
      return value.slice(selectionStart, selectionEnd)
    },
  }), [value, onChange])

  const cls =
    'absolute inset-0 m-0 p-3 font-mono text-code leading-[1.6] whitespace-pre-wrap break-words border-0 outline-none resize-none overflow-auto'

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg-surface">
      {/* 高亮层(只读,无事件):含行差异背景 */}
      <pre
        ref={preRef}
        aria-hidden
        className={`${cls} pointer-events-none text-ink-primary`}
      >
        {value ? (
          <HighlightedJson source={value} lineMarks={lineMarks} search={search} />
        ) : (
          <span className="text-ink-tertiary">{placeholder ?? ''}</span>
        )}
        {/* 保证末尾换行可见 */}
        {value && value.endsWith('\n') ? '\n' : ''}
      </pre>
      {/* 输入层:文字透明,光标可见。placeholder 由下层 pre 渲染,避免重叠。
          selection 用半透明色,让下层高亮文字透出来,选区仍可见 */}
      <textarea
        ref={taRef}
        value={value}
        onChange={handle}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        spellCheck={false}
        autoFocus={autoFocus}
        className={`${cls} codearea-input bg-transparent text-transparent caret-ink-primary`}
      />
    </div>
  )
})
