import { useState, useMemo } from 'react'
import type { ToolProps } from '../shared'
import { ActionBtn, CopyBtn } from '../shared'
import { tolerantParse, parseError } from './parse'
import { JsonTree } from './JsonTree'
import { JsonDiff } from './JsonDiff'

type Mode = 'tree' | 'diff' | 'raw'

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

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 border-b border-line bg-bg-surface px-4 py-2">
        <div className="flex rounded-btn border border-line p-0.5">
          {(['tree', 'diff', 'raw'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-btn px-2.5 py-0.5 text-caption ${
                mode === m ? 'bg-accent-bg text-accent' : 'text-ink-secondary hover:bg-bg-hover'
              }`}
            >
              {m === 'tree' ? '树形' : m === 'diff' ? '对比' : '原文'}
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
        <div className="ml-auto flex gap-1.5">
          {mode === 'tree' && <ActionBtn onClick={() => onInput(formatted)}>格式化</ActionBtn>}
          <CopyBtn text={formatted} label="复制" />
        </div>
      </div>

      {/* 错误提示 */}
      {errInfo && mode !== 'diff' && (
        <div className="border-b border-line bg-bg-subtle px-4 py-1.5 text-caption text-danger">
          {errInfo.message}
        </div>
      )}

      {/* 内容区 */}
      <div className="flex flex-1 overflow-hidden">
        {mode === 'tree' && (
          <div className="flex w-full">
            <div className="flex w-1/2 flex-col border-r border-line">
              <div className="border-b border-line px-3 py-1 text-label text-ink-tertiary">输入</div>
              <textarea
                value={input}
                onChange={(e) => onInput(e.target.value)}
                spellCheck={false}
                className="flex-1 resize-none bg-bg-surface p-3 font-mono text-code text-ink-primary outline-none"
                placeholder='粘贴 JSON(容错:尾逗号、单引号、注释)'
              />
            </div>
            <div className="flex w-1/2 flex-col bg-bg-subtle">
              <div className="border-b border-line px-3 py-1 text-label text-ink-tertiary">树形视图</div>
              <div className="flex-1 overflow-auto p-2">
                {parsed !== null ? (
                  <JsonTree data={parsed} />
                ) : (
                  <div className="p-3 text-caption text-ink-tertiary">输入有效 JSON 后显示树形</div>
                )}
              </div>
            </div>
          </div>
        )}

        {mode === 'raw' && (
          <div className="flex w-full">
            <div className="flex w-1/2 flex-col border-r border-line">
              <div className="border-b border-line px-3 py-1 text-label text-ink-tertiary">输入</div>
              <textarea
                value={input}
                onChange={(e) => onInput(e.target.value)}
                spellCheck={false}
                className="flex-1 resize-none bg-bg-surface p-3 font-mono text-code text-ink-primary outline-none"
              />
            </div>
            <div className="flex w-1/2 flex-col bg-bg-subtle">
              <div className="border-b border-line px-3 py-1 text-label text-ink-tertiary">格式化</div>
              <pre className="flex-1 overflow-auto p-3 font-mono text-code text-ink-secondary">
                {formatted || <span className="text-ink-tertiary">—</span>}
              </pre>
            </div>
          </div>
        )}

        {mode === 'diff' && (
          <JsonDiff left={input} right={diffInput} onLeft={onInput} onRight={setDiffInput} />
        )}
      </div>
    </div>
  )
}
