import { Fragment, type ReactNode } from 'react'

// ============ JSON 语法高亮 ============
// 明快配色:在简约基调上提亮,让各类型一目了然
//   key    蓝      #2b5cd9
//   string 绿      #1a8a47
//   number 琥珀橙  #cc6f1a
//   bool   紫      #7a3fb0
//   null   灰      #80868f
//   punct  浅灰    #a0a6b2

const COL = {
  key: '#2b5cd9',
  string: '#1a8a47',
  number: '#cc6f1a',
  boolean: '#7a3fb0',
  null: '#80868f',
  punct: '#a0a6b2',
}

/** 差异行标记:added=右侧新增 / removed=左侧删除 / changed=同位修改 */
export type LineMark = 'added' | 'removed' | 'changed'

type Tok = { t: 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'ws'; v: string }

/**
 * 容错 JSON 分词:支持尾逗号、单/双引号、注释、未引号 key。
 * 返回 token 流,渲染时按类型上色。
 */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = src.length
  const push = (t: Tok['t'], v: string) => {
    if (v) toks.push({ t, v })
  }
  const isIdStart = (c: string) => /[A-Za-z_$]/.test(c)
  const isIdPart = (c: string) => /[A-Za-z0-9_$-]/.test(c)

  while (i < n) {
    const c = src[i]

    // 空白
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i + 1
      while (j < n && /\s/.test(src[j])) j++
      push('ws', src.slice(i, j))
      i = j
      continue
    }

    // 注释 //... 或 /*...*/
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2
      while (j < n && src[j] !== '\n') j++
      push('ws', src.slice(i, j))
      i = j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(n, j + 2)
      push('ws', src.slice(i, j))
      i = j
      continue
    }

    // 字符串(单/双引号,支持 \" \' 转义)
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === quote) {
          j++
          break
        }
        j++
      }
      const raw = src.slice(i, j)
      // 判断是否为 key:后面跳过空白遇到 ':'
      let k = j
      while (k < n && /\s/.test(src[k])) k++
      push(src[k] === ':' ? 'key' : 'string', raw)
      i = j
      continue
    }

    // 数字
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1
      while (j < n && /[0-9eE+\-.]/.test(src[j])) j++
      push('number', src.slice(i, j))
      i = j
      continue
    }

    // 标识符:可能是 true/false/null,也可能是未引号 key
    if (isIdStart(c)) {
      let j = i + 1
      while (j < n && isIdPart(src[j])) j++
      const word = src.slice(i, j)
      if (word === 'true' || word === 'false') push('boolean', word)
      else if (word === 'null') push('null', word)
      else {
        // 未引号 key:仅当后面接 ':' 时才视为 key
        let k = j
        while (k < n && /\s/.test(src[k])) k++
        push(src[k] === ':' ? 'key' : 'string', word)
      }
      i = j
      continue
    }

    // 标点 { } [ ] : ,
    push('punct', c)
    i++
  }

  return toks
}

// 差异行背景色(浅,保证可读)与左侧标记条颜色(饱和,提示性强)
const LINE_BG: Record<LineMark, string> = {
  added: '#eafaf1',
  removed: '#fdeaea',
  changed: '#fdf2e0',
}
const LINE_BAR: Record<LineMark, string> = {
  added: '#1a8a47',
  removed: '#d65a5a',
  changed: '#cc6f1a',
}

/** 把 token 流按行拆分(换行符不进入行内容),返回每行的 token 列表 */
function splitLines(toks: Tok[]): Tok[][] {
  const lines: Tok[][] = [[]]
  for (const t of toks) {
    if (t.t === 'ws' && t.v.includes('\n')) {
      const parts = t.v.split('\n')
      if (parts[0]) lines[lines.length - 1].push({ t: 'ws', v: parts[0] })
      for (let k = 1; k < parts.length; k++) {
        lines.push([])
        if (parts[k]) lines[lines.length - 1].push({ t: 'ws', v: parts[k] })
      }
    } else {
      lines[lines.length - 1].push(t)
    }
  }
  return lines
}

export const SEARCH_BG = '#fff35c' // 搜索高亮:饱和黄,醒目

/** 在单个 token 文本内按搜索词切片,匹配段用 <mark> 黄底渲染 */
function renderWithSearch(value: string, color: string, search: string): ReactNode {
  return highlightText(value, color, search)
}

/** 把任意纯文本按搜索词切片:匹配段黄底 <mark>,其余按 color 着色。
 *  供 token 渲染(renderWithSearch)和非 token 场景(JsonTree)共用。 */
export function highlightText(value: string, color: string, search?: string): ReactNode {
  if (!search) return <span style={{ color }}>{value}</span>
  // 转义正则元字符,大小写不敏感
  const re = new RegExp(escapeRegExp(search), 'gi')
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) out.push(<span key={k++} style={{ color }}>{value.slice(last, m.index)}</span>)
    out.push(
      <mark key={k++} style={{ background: SEARCH_BG, color, padding: '0 1px', borderRadius: 2 }}>
        {m[0]}
      </mark>,
    )
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++ // 避免零宽死循环
  }
  if (last < value.length) out.push(<span key={k++} style={{ color }}>{value.slice(last)}</span>)
  return <>{out}</>
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderTokens(toks: Tok[], search?: string): ReactNode {
  const out: ReactNode[] = []
  toks.forEach((t, i) => {
    if (t.t === 'ws') {
      out.push(<Fragment key={i}>{t.v}</Fragment>)
    } else if (search) {
      out.push(<Fragment key={i}>{renderWithSearch(t.v, COL[t.t], search)}</Fragment>)
    } else {
      out.push(
        <span key={i} style={{ color: COL[t.t] }}>
          {t.v}
        </span>,
      )
    }
  })
  return <>{out}</>
}

/**
 * 把 JSON 字符串渲染为带语法高亮的 React 节点。
 * 用于只读展示(格式化输出、原文高亮、编辑器底层高亮等)。
 * 可选 lineMarks:按 1 起始行号标记差异行,渲染整行背景 + 左侧色条。
 */
export function HighlightedJson({
  source,
  lineMarks,
  search,
}: {
  source: string
  lineMarks?: Record<number, LineMark>
  /** 搜索词:匹配段以黄底高亮 */
  search?: string
}) {
  if (!source) return null
  const lines = splitLines(tokenize(source))
  return (
    <>
      {lines.map((lineToks, idx) => {
        const mark = lineMarks?.[idx + 1]
        // 用 inset box-shadow 画左侧色条,不影响布局/对齐
        const style = mark
          ? {
              background: LINE_BG[mark],
              boxShadow: `inset 2px 0 0 ${LINE_BAR[mark]}`,
            }
          : undefined
        return (
          <div key={idx} style={style} className="min-h-[1.6em] whitespace-pre-wrap break-words">
            {lineToks.length ? renderTokens(lineToks, search) : '\u200b'}
          </div>
        )
      })}
    </>
  )
}

export { tokenize, COL as HL_COLORS }
