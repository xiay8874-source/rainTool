import type { ToolProps } from './shared'
import { DualPane, CopyBtn } from './shared'

export default function UnicodeCodec({ input, onInput }: ToolProps) {
  const toUnicode = (s: string) =>
    s.replace(/[\s\S]/g, (ch) => {
      const code = ch.codePointAt(0)!
      return code > 127 ? `\\u${code.toString(16).padStart(4, '0')}` : ch
    })
  const fromUnicode = (s: string) =>
    s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))

  const encoded = input ? toUnicode(input) : ''
  const decoded = input ? fromUnicode(input) : ''

  return (
    <DualPane
      inputLabel="输入文本 / \\uXXXX"
      outputLabel="编码 ⇄ 解码"
      input={input}
      onInput={onInput}
      output={`${encoded ? '编码: ' + encoded + '\n\n' : ''}${decoded && decoded !== input ? '解码: ' + decoded : ''}`}
      actions={<CopyBtn text={encoded} label="复制编码" />}
    />
  )
}
