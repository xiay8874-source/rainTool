import { useEffect, useMemo, useState } from 'react'
import type { ToolProps } from './shared'
import { ToolPane, CopyBtn, ActionBtn } from './shared'

// 常用时区(含 UTC 与本地)
const TIMEZONES = [
  { id: 'local', label: '本地', tz: undefined as string | undefined },
  { id: 'UTC', label: 'UTC', tz: 'UTC' },
  { id: 'Asia/Shanghai', label: '上海 (CST)', tz: 'Asia/Shanghai' },
  { id: 'Asia/Tokyo', label: '东京 (JST)', tz: 'Asia/Tokyo' },
  { id: 'Asia/Singapore', label: '新加坡 (SGT)', tz: 'Asia/Singapore' },
  { id: 'Asia/Kolkata', label: '孟买 (IST)', tz: 'Asia/Kolkata' },
  { id: 'Europe/London', label: '伦敦 (GMT/BST)', tz: 'Europe/London' },
  { id: 'Europe/Berlin', label: '柏林 (CET)', tz: 'Europe/Berlin' },
  { id: 'America/New_York', label: '纽约 (EST/EDT)', tz: 'America/New_York' },
  { id: 'America/Los_Angeles', label: '洛杉矶 (PST/PDT)', tz: 'America/Los_Angeles' },
]

const fmt2 = (n: number) => String(n).padStart(2, '0')

/**
 * 把时间戳(ms)按指定时区格式化为 YYYY-MM-DD HH:mm:ss
 * 用 Intl.DateTimeFormat 取各分量(支持任意 IANA 时区)。
 */
function formatInTz(ms: number, tz?: string): string {
  const d = new Date(ms)
  // en-CA 产出 YYYY-MM-DD 格式的日期部分,便于拼装
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  // hour12:false 在某些环境可能产出 "24",修正为 "00"
  let h = get('hour')
  if (h === '24') h = '00'
  return `${get('year')}-${get('month')}-${get('day')} ${h}:${get('minute')}:${get('second')}`
}

/**
 * 计算指定时区相对 UTC 的偏移(分钟),用于显示 +XX:XX 及解析补偿。
 * 通过对比同一时刻在目标时区与 UTC 下的格式化结果得出。
 */
function tzOffsetMinutes(ms: number, tz?: string): number {
  const d = new Date(ms)
  if (!tz) return -d.getTimezoneOffset() // 本地:getTimezoneOffset 返回 UTC-本地,取反
  // 目标时区的"墙上时间"当作 UTC 解析,减去真实 UTC 墙上时间
  const tzParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)
  const g = (t: string) => Number(partsVal(tzParts, t))
  let hh = g('hour'); if (hh === 24) hh = 0
  const tzAsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), hh, g('minute'), g('second'))
  const realUtc = Math.floor(d.getTime() / 1000) * 1000
  return Math.round((tzAsUtc - realUtc) / 60000)
}

function partsVal(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? ''
}

function offsetLabel(min: number): string {
  const sign = min >= 0 ? '+' : '-'
  const abs = Math.abs(min)
  return `UTC${sign}${fmt2(Math.floor(abs / 60))}:${fmt2(abs % 60)}`
}

/**
 * 按指定时区解析日期字符串 → Date(UTC ms)。
 * 支持格式:YYYY-MM-DD HH:mm:ss、YYYY-MM-DDTHH:mm:ss、YYYY/MM/DD HH:mm:ss 等。
 * 思路:把字符串拆成各分量,用 Date.UTC 构造"当作该时区墙上时间"的 UTC ms,
 * 再减去该时区偏移,得到真实的 UTC ms。
 */
function parseDateInTz(s: string, tz?: string): Date | null {
  // 标准化:替换 / 为 -,替换 T 为空格
  const normalized = s.replace(/\//g, '-').replace(/T/g, ' ').trim()
  // 匹配 YYYY-MM-DD[ HH:mm[:ss]]
  const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (!m) {
    // 兜底:交给原生 Date 解析(ISO 带Z等)
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }
  const [, y, mo, d1, h, mi, se] = m
  const year = Number(y)
  const month = Number(mo) - 1
  const day = Number(d1)
  const hour = h ? Number(h) : 0
  const minute = mi ? Number(mi) : 0
  const second = se ? Number(se) : 0
  // "墙上时间"当作 UTC 构造
  const wallAsUtc = Date.UTC(year, month, day, hour, minute, second)
  // 计算该时区在此时刻的偏移,补偿得到真实 UTC ms
  const offset = tzOffsetMinutes(wallAsUtc, tz)
  return new Date(wallAsUtc - offset * 60000)
}

// 工具栏/输入框样式
const inputCls =
  'h-9 w-full rounded-btn border border-line bg-bg-surface px-3 font-mono text-code text-ink-primary outline-none focus:border-accent'

export default function Timestamp(_: ToolProps) {
  const [now, setNow] = useState(Date.now())
  // 时间戳输入(秒或毫秒,自动判断)与日期输入独立维护,互转联动
  const [tsInput, setTsInput] = useState('')
  const [dateInput, setDateInput] = useState('')
  const [tzId, setTzId] = useState('local')

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const tz = useMemo(
    () => TIMEZONES.find((t) => t.id === tzId) ?? TIMEZONES[0],
    [tzId],
  )

  const offset = useMemo(() => tzOffsetMinutes(now, tz.tz), [now, tz.tz])

  // 时间戳输入 → 日期(实时转换)
  const dateFromTs = useMemo(() => {
    const trimmed = tsInput.trim()
    if (!trimmed) return ''
    const asNum = Number(trimmed)
    if (isNaN(asNum) || trimmed === '') return ''
    // 秒/毫秒自动判断:10 位及以下视为秒
    const ms = trimmed.length <= 10 ? asNum * 1000 : asNum
    const d = new Date(ms)
    if (isNaN(d.getTime())) return ''
    return formatInTz(ms, tz.tz)
  }, [tsInput, tz.tz])

  // 日期输入 → 时间戳(实时转换,按选定时区解析)
  const tsFromDate = useMemo(() => {
    const trimmed = dateInput.trim()
    if (!trimmed) return ''
    const d = parseDateInTz(trimmed, tz.tz)
    if (!d || isNaN(d.getTime())) return ''
    return String(Math.floor(d.getTime() / 1000))
  }, [dateInput, tz.tz])

  // 时区切换时,若有日期输入则重新格式化对应的时间戳结果(由 useMemo 自动响应)
  // 但时间戳→日期的结果也会随 tz 变化重新格式化,无需额外处理

  // 联动回写:在一边输入时,把转换结果填到另一边(只读显示,不覆盖用户输入)
  // 这里采用"结果区"展示而非回写输入框,避免光标跳动与循环

  const fillNow = () => {
    const sec = Math.floor(now / 1000)
    setTsInput(String(sec))
  }

  const clearAll = () => {
    setTsInput('')
    setDateInput('')
  }

  // 当前时间在选定时区下的显示
  const nowFormatted = formatInTz(now, tz.tz)

  return (
    <ToolPane title="时间戳 ⇄ 日期">
      <div className="flex h-full flex-col gap-4">
        {/* 当前时间 + 时区选择 */}
        <div className="flex flex-col gap-2 rounded-card border border-line bg-bg-surface p-3">
          <div className="flex items-center gap-3">
            <span className="text-caption text-ink-tertiary">当前时间戳</span>
            <span className="font-mono text-code text-ink-primary">{Math.floor(now / 1000)}</span>
            <span className="text-ink-tertiary">/</span>
            <span className="font-mono text-code text-ink-secondary">{now}</span>
            <div className="ml-auto flex gap-1.5">
              <ActionBtn onClick={() => navigator.clipboard?.writeText(String(Math.floor(now / 1000)))}>
                复制秒
              </ActionBtn>
              <ActionBtn onClick={() => navigator.clipboard?.writeText(String(now))}>复制毫秒</ActionBtn>
              <ActionBtn onClick={fillNow} primary>填入</ActionBtn>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-caption text-ink-tertiary">当前时间</span>
            <span className="font-mono text-code text-ink-primary">{nowFormatted}</span>
            <span className="text-label text-ink-tertiary">{tz.label} · {offsetLabel(offset)}</span>
          </div>
          {/* 时区选择 */}
          <div className="flex items-center gap-2">
            <span className="text-caption text-ink-tertiary">时区</span>
            <select
              value={tzId}
              onChange={(e) => setTzId(e.target.value)}
              className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary outline-none focus:border-accent"
            >
              {TIMEZONES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 双向转换:两个独立输入,各自实时转出对方 */}
        <div className="flex flex-1 flex-col gap-3">
          {/* 时间戳 → 日期 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-label text-ink-tertiary">
                时间戳(秒/毫秒自动判断)→ 日期 ({tz.label})
              </label>
              <span className="text-label text-ink-tertiary">{offsetLabel(offset)}</span>
            </div>
            <input
              type="text"
              value={tsInput}
              onChange={(e) => setTsInput(e.target.value)}
              placeholder="输入时间戳,如 1783284476 或 1783284476000"
              spellCheck={false}
              className={inputCls}
            />
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center rounded-btn border border-line bg-bg-subtle px-3 font-mono text-code text-ink-primary">
                {dateFromTs || <span className="text-ink-tertiary">—</span>}
              </div>
              <CopyBtn text={dateFromTs} label="复制日期" />
            </div>
          </div>

          {/* 日期 → 时间戳 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-label text-ink-tertiary">
                日期 → 时间戳(秒)({tz.label})
              </label>
              <span className="text-label text-ink-tertiary">按上方时区解析</span>
            </div>
            <input
              type="text"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              placeholder="输入日期,如 2026-07-06 12:00:00"
              spellCheck={false}
              className={inputCls}
            />
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center rounded-btn border border-line bg-bg-subtle px-3 font-mono text-code text-ink-primary">
                {tsFromDate || <span className="text-ink-tertiary">—</span>}
              </div>
              <CopyBtn text={tsFromDate} label="复制时间戳" />
            </div>
          </div>

          <div className="mt-auto flex justify-end">
            <ActionBtn onClick={clearAll}>清空</ActionBtn>
          </div>
        </div>
      </div>
    </ToolPane>
  )
}
