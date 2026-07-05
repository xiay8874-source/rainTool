import { useState } from 'react'
import type { ToolProps } from './shared'
import { DualPane, CopyBtn, ActionBtn } from './shared'
import { tolerantParse } from './json-workbench/parse'

export default function JsonFormat({ input, onInput }: ToolProps) {
  const [indent, setIndent] = useState(2)
  const [err, setErr] = useState('')

  let formatted = ''
  let minified = ''
  if (input.trim()) {
    try {
      const obj = tolerantParse(input)
      formatted = JSON.stringify(obj, null, indent)
      minified = JSON.stringify(obj)
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <DualPane
      inputLabel="输入 JSON"
      outputLabel={err ? '错误' : '格式化 / 压缩'}
      input={input}
      onInput={onInput}
      inputPlaceholder="粘贴 JSON(支持容错:尾逗号、单引号、注释)"
      output={err || `${formatted ? formatted + '\n\n—— 压缩 ——\n' + minified : ''}`}
      actions={
        <>
          <select
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
            className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-secondary outline-none"
          >
            <option value={2}>2 空格</option>
            <option value={4}>4 空格</option>
            <option value={0}>无缩进</option>
          </select>
          <ActionBtn onClick={() => onInput(formatted)}>用格式化结果替换</ActionBtn>
          <CopyBtn text={formatted} label="复制格式化" />
          <CopyBtn text={minified} label="复制压缩" />
        </>
      }
    />
  )
}
