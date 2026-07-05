import type { ToolProps } from './shared'
import { DualPane, CopyBtn } from './shared'

export default function HtmlEntity({ input, onInput }: ToolProps) {
  const escape = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  const unescape = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')

  const escaped = input ? escape(input) : ''
  const unescaped = input ? unescape(input) : ''

  return (
    <DualPane
      inputLabel="输入文本 / HTML"
      outputLabel="转义 ⇄ 反转义"
      input={input}
      onInput={onInput}
      output={`${escaped ? '转义: ' + escaped + '\n\n' : ''}${unescaped && unescaped !== input ? '反转义: ' + unescaped : ''}`}
      actions={<CopyBtn text={escaped} label="复制转义" />}
    />
  )
}
