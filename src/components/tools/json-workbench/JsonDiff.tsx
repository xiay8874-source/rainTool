import { useMemo } from 'react'
import { tolerantParse } from './parse'

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
    if (lErr || rErr) return { lErr, rErr, lines: [] as DiffLine[] }
    return { lErr: '', rErr: '', lines: diffLines(l, r) }
  }, [left, right])

  return (
    <div className="flex w-full flex-col">
      <div className="flex flex-1">
        <div className="flex w-1/2 flex-col border-r border-line">
          <div className="border-b border-line px-3 py-1 text-label text-ink-tertiary">JSON A</div>
          <textarea
            value={left}
            onChange={(e) => onLeft(e.target.value)}
            spellCheck={false}
            placeholder="JSON A"
            className="flex-1 resize-none bg-bg-surface p-3 font-mono text-code text-ink-primary outline-none"
          />
        </div>
        <div className="flex w-1/2 flex-col">
          <div className="border-b border-line px-3 py-1 text-label text-ink-tertiary">JSON B</div>
          <textarea
            value={right}
            onChange={(e) => onRight(e.target.value)}
            spellCheck={false}
            placeholder="JSON B"
            className="flex-1 resize-none bg-bg-surface p-3 font-mono text-code text-ink-primary outline-none"
          />
        </div>
      </div>
      {/* 差异结果 */}
      <div className="h-40 overflow-auto border-t border-line bg-bg-subtle p-2">
        {(result.lErr || result.rErr) ? (
          <div className="text-caption text-danger">
            {result.lErr && `A: ${result.lErr}`}
            {result.rErr && ` B: ${result.rErr}`}
          </div>
        ) : result.lines.filter((l) => l.status !== 'same').length === 0 ? (
          <div className="text-caption text-ink-tertiary">两份 JSON 相同</div>
        ) : (
          result.lines
            .filter((l) => l.status !== 'same')
            .map((l, i) => (
              <div key={i} className="flex gap-2 font-mono text-code">
                <span className="w-16 text-label">
                  {l.status === 'added' && <span className="text-ink-tertiary">+ </span>}
                  {l.status === 'removed' && <span className="text-danger">- </span>}
                  {l.status === 'changed' && <span className="text-ink-secondary">~ </span>}
                  {l.status}
                </span>
                <span className="flex-1 text-ink-secondary">{l.path}</span>
                {l.left !== undefined && <span className="text-danger">{l.left}</span>}
                {l.status === 'changed' && <span className="text-ink-tertiary">→</span>}
                {l.right !== undefined && <span className="text-ink-primary">{l.right}</span>}
              </div>
            ))
        )}
      </div>
    </div>
  )
}

interface DiffLine {
  path: string
  status: 'same' | 'added' | 'removed' | 'changed'
  left?: string
  right?: string
}

// 结构化差异:展开两个对象到 path -> value,逐 path 对比
function diffLines(l: unknown, r: unknown): DiffLine[] {
  const lm = flatten(l, '')
  const rm = flatten(r, '')
  const paths = new Set([...Object.keys(lm), ...Object.keys(rm)])
  const lines: DiffLine[] = []
  for (const p of paths) {
    const lv = lm[p]
    const rv = rm[p]
    if (lv === rv) {
      lines.push({ path: p, status: 'same', left: lv, right: rv })
    } else if (lv === undefined) {
      lines.push({ path: p, status: 'added', right: rv })
    } else if (rv === undefined) {
      lines.push({ path: p, status: 'removed', left: lv })
    } else {
      lines.push({ path: p, status: 'changed', left: lv, right: rv })
    }
  }
  return lines.sort((a, b) => a.path.localeCompare(b.path))
}

function flatten(v: unknown, prefix: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (val: unknown, path: string) => {
    if (val === null) {
      out[path] = 'null'
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => walk(item, `${path}[${i}]`))
    } else if (typeof val === 'object') {
      for (const [k, vv] of Object.entries(val as Record<string, unknown>)) {
        walk(vv, path ? `${path}.${k}` : k)
      }
    } else {
      out[path] = String(val)
    }
  }
  walk(v, prefix)
  return out
}
