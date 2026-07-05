import type { ToolProps } from './shared'
import { DualPane, CopyBtn } from './shared'

export default function UrlCodec({ input, onInput }: ToolProps) {
  let encoded = ''
  let decoded = ''
  try {
    if (input) encoded = encodeURIComponent(input)
  } catch {
    /* ignore */
  }
  try {
    if (input) decoded = decodeURIComponent(input)
  } catch {
    /* ignore */
  }

  return (
    <DualPane
      inputLabel="输入文本 / URL"
      outputLabel="编码 ⇄ 解码"
      input={input}
      onInput={onInput}
      output={`${encoded ? '编码: ' + encoded + '\n\n' : ''}${decoded ? '解码: ' + decoded : ''}`}
      actions={<CopyBtn text={encoded} label="复制编码" />}
    />
  )
}
