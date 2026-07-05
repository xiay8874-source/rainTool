import { useState, type ReactNode } from 'react'
import { HL_COLORS as C, highlightText } from './highlight'

export function JsonTree({ data, search }: { data: unknown; search?: string }) {
  return (
    <div className="font-mono text-code">
      <Node label="root" value={data} depth={0} defaultOpen search={search} />
    </div>
  )
}

function Node({
  label,
  value,
  depth,
  defaultOpen,
  search,
}: {
  label: string
  value: unknown
  depth: number
  defaultOpen?: boolean
  search?: string
}) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 2)
  const isArr = Array.isArray(value)
  const isObj = value !== null && typeof value === 'object' && !isArr

  // key 文本:"label": (含引号和冒号空格,与高亮层 token 一致)
  const keyText = `"${label}": `

  if (!isArr && !isObj) {
    return (
      <div style={{ paddingLeft: depth * 14 }} className="py-0.5">
        {highlightText(keyText, C.key, search)}
        <ValueView value={value} search={search} />
      </div>
    )
  }

  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)

  const typeLabel = isArr ? `Array(${entries.length})` : `Object`

  return (
    <div style={{ paddingLeft: depth * 14 }} className="py-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-ink-secondary hover:text-ink-primary"
      >
        <span style={{ color: C.punct }}>{open ? '▾' : '▸'}</span>
        {highlightText(keyText, C.key, search)}
        {!open && <span className="text-ink-tertiary">{typeLabel}</span>}
      </button>
      {open && (
        <div>
          <span style={{ color: C.punct }}>{isArr ? '[' : '{'}</span>
          {entries.map(([k, v]) => (
            <Node key={k} label={k} value={v} depth={depth + 1} search={search} />
          ))}
          <div style={{ paddingLeft: depth * 14 }}>
            <span style={{ color: C.punct }}>{isArr ? ']' : '}'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function ValueView({ value, search }: { value: unknown; search?: string }): ReactNode {
  if (value === null) return highlightText('null', C.null, search)
  switch (typeof value) {
    case 'string':
      return highlightText(`"${value}"`, C.string, search)
    case 'number':
      return highlightText(String(value), C.number, search)
    case 'boolean':
      return highlightText(String(value), C.boolean, search)
    default:
      return <span className="text-ink-tertiary">{String(value)}</span>
  }
}
