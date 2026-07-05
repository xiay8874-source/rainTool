import { useState } from 'react'

export function JsonTree({ data }: { data: unknown }) {
  return (
    <div className="font-mono text-code">
      <Node label="root" value={data} depth={0} defaultOpen />
    </div>
  )
}

function Node({
  label,
  value,
  depth,
  defaultOpen,
}: {
  label: string
  value: unknown
  depth: number
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 2)
  const isArr = Array.isArray(value)
  const isObj = value !== null && typeof value === 'object' && !isArr

  if (!isArr && !isObj) {
    return (
      <div style={{ paddingLeft: depth * 14 }} className="py-0.5">
        <span className="text-ink-tertiary">"{label}": </span>
        <ValueView value={value} />
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
        <span className="text-ink-tertiary">{open ? '▾' : '▸'}</span>
        <span className="text-ink-tertiary">"{label}": </span>
        {!open && <span className="text-ink-tertiary">{typeLabel}</span>}
      </button>
      {open && (
        <div>
          <span className="text-ink-tertiary">{isArr ? '[' : '{'}</span>
          {entries.map(([k, v]) => (
            <Node key={k} label={k} value={v} depth={depth + 1} />
          ))}
          <div style={{ paddingLeft: depth * 14 }} className="text-ink-tertiary">
            {isArr ? ']' : '}'}
          </div>
        </div>
      )}
    </div>
  )
}

function ValueView({ value }: { value: unknown }) {
  if (value === null) return <span className="text-ink-tertiary">null</span>
  switch (typeof value) {
    case 'string':
      return <span className="text-ink-secondary">"{value}"</span>
    case 'number':
      return <span className="text-ink-primary">{value}</span>
    case 'boolean':
      return <span className="text-ink-primary">{String(value)}</span>
    default:
      return <span className="text-ink-tertiary">{String(value)}</span>
  }
}
