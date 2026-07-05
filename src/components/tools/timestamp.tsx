import { useEffect, useState } from 'react'
import type { ToolProps } from './shared'
import { ToolPane, CopyBtn, ActionBtn } from './shared'

export default function Timestamp({ input, onInput }: ToolProps) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // 输入是时间戳 → 日期
  // 输入是日期字符串 → 时间戳
  let fromTs = ''
  let fromDate = ''
  const trimmed = input.trim()
  if (trimmed) {
    const asNum = Number(trimmed)
    if (!isNaN(asNum)) {
      // 判断秒/毫秒
      const ms = trimmed.length <= 10 ? asNum * 1000 : asNum
      const d = new Date(ms)
      if (!isNaN(d.getTime())) fromTs = format(d)
    } else {
      const d = new Date(trimmed)
      if (!isNaN(d.getTime())) fromDate = String(d.getTime())
    }
  }

  const fmt = (n: number) => String(n).padStart(2, '0')
  function format(d: Date) {
    return `${d.getFullYear()}-${fmt(d.getMonth() + 1)}-${fmt(d.getDate())} ${fmt(d.getHours())}:${fmt(d.getMinutes())}:${fmt(d.getSeconds())}`
  }

  const setNowInput = () => onInput(String(Math.floor(now / 1000)))

  return (
    <ToolPane title="时间戳 ⇄ 日期">
      <div className="flex h-full flex-col gap-4">
        <div className="flex items-center gap-3 rounded-card border border-line bg-bg-surface p-3">
          <span className="text-caption text-ink-tertiary">当前时间戳</span>
          <span className="font-mono text-code text-ink-primary">{Math.floor(now / 1000)}</span>
          <span className="text-ink-tertiary">/</span>
          <span className="font-mono text-code text-ink-secondary">{now}</span>
          <div className="ml-auto flex gap-1.5">
            <ActionBtn onClick={() => navigator.clipboard?.writeText(String(Math.floor(now / 1000)))}>
              复制秒
            </ActionBtn>
            <ActionBtn onClick={() => navigator.clipboard?.writeText(String(now))}>复制毫秒</ActionBtn>
            <ActionBtn onClick={setNowInput} primary>填入</ActionBtn>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2">
          <textarea
            value={input}
            onChange={(e) => onInput(e.target.value)}
            placeholder="输入时间戳(秒或毫秒)或日期字符串(如 2026-07-06 12:00:00)"
            spellCheck={false}
            className="h-24 resize-none rounded-card border border-line bg-bg-surface p-3 font-mono text-code text-ink-primary outline-none focus:border-accent"
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-card border border-line bg-bg-subtle p-3">
              <div className="mb-1 text-label text-ink-tertiary">作为时间戳 → 日期</div>
              <div className="font-mono text-code text-ink-primary">{fromTs || '—'}</div>
            </div>
            <div className="rounded-card border border-line bg-bg-subtle p-3">
              <div className="mb-1 text-label text-ink-tertiary">作为日期 → 时间戳</div>
              <div className="font-mono text-code text-ink-primary">{fromDate || '—'}</div>
            </div>
          </div>
          <div className="flex gap-1.5">
            <CopyBtn text={fromTs} label="复制日期" />
            <CopyBtn text={fromDate} label="复制时间戳" />
          </div>
        </div>
      </div>
    </ToolPane>
  )
}
