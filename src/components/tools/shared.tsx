import type { ReactNode, RefObject } from 'react'

// 工具组件统一 props
export interface ToolProps {
  input: string
  onInput: (v: string) => void
  config?: string
}

// 左输入右输出的通用布局
export function ToolPane({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <div className="flex h-full flex-col p-4">
      {title && <div className="mb-2 text-page text-ink-primary">{title}</div>}
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  )
}

// 双栏:输入 / 输出
export function DualPane({
  inputLabel,
  outputLabel,
  input,
  onInput,
  output,
  outputNode,
  inputPlaceholder,
  actions,
  outputRef,
}: {
  inputLabel?: string
  outputLabel?: string
  input: string
  onInput: (v: string) => void
  output: string
  /** 自定义输出内容(优先于 output 字符串,用于高亮渲染) */
  outputNode?: ReactNode
  inputPlaceholder?: string
  actions?: ReactNode
  /** 可选:输出 <pre> 的 ref,供查找栏滚动定位 */
  outputRef?: RefObject<HTMLPreElement>
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex gap-3" style={{ height: 'calc(100% - 32px)' }}>
        <div className="flex flex-1 flex-col">
          {inputLabel && <div className="mb-1 text-label text-ink-tertiary">{inputLabel}</div>}
          <textarea
            value={input}
            onChange={(e) => onInput(e.target.value)}
            placeholder={inputPlaceholder}
            spellCheck={false}
            className="flex-1 resize-none rounded-card border border-line bg-bg-surface p-3 font-mono text-code text-ink-primary outline-none focus:border-accent"
          />
        </div>
        <div className="flex flex-1 flex-col">
          {outputLabel && <div className="mb-1 text-label text-ink-tertiary">{outputLabel}</div>}
          <pre ref={outputRef} className="flex-1 overflow-auto rounded-card border border-line bg-bg-subtle p-3 font-mono text-code text-ink-secondary">
            {outputNode ?? (output || <span className="text-ink-tertiary">—</span>)}
          </pre>
        </div>
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  )
}

// 复制按钮
export function CopyBtn({ text, label = '复制' }: { text: string; label?: string }) {
  const copy = () => {
    navigator.clipboard?.writeText(text).catch(() => {})
  }
  return (
    <button
      onClick={copy}
      disabled={!text}
      className="rounded-btn border border-line px-2 py-1 text-caption text-ink-secondary hover:bg-bg-hover hover:text-ink-primary disabled:opacity-40"
    >
      {label}
    </button>
  )
}

export function ActionBtn({
  children,
  onClick,
  primary,
}: {
  children: ReactNode
  onClick?: () => void
  primary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-btn px-2.5 py-1 text-caption ${
        primary
          ? 'bg-accent text-white hover:opacity-90'
          : 'border border-line text-ink-secondary hover:bg-bg-hover hover:text-ink-primary'
      }`}
    >
      {children}
    </button>
  )
}
