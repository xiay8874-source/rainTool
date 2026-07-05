import type { ToolProps } from './shared'
import { DualPane, CopyBtn } from './shared'

export default function Base64Tool({ input, onInput }: ToolProps) {
  let encode = ''
  let decode = ''
  let err = ''
  try {
    if (input) encode = btoa(unescape(encodeURIComponent(input)))
  } catch {
    err = '编码失败'
  }
  try {
    if (input) decode = decodeURIComponent(escape(atob(input)))
  } catch {
    /* 输入非合法 base64,忽略 */
  }

  return (
    <DualPane
      inputLabel="输入文本 / Base64"
      outputLabel="编码 ⇄ 解码"
      input={input}
      onInput={onInput}
      inputPlaceholder="输入文本会自动 Base64 编码;输入 Base64 会自动解码"
      output={err || `${encode ? '编码: ' + encode + '\n\n' : ''}${decode ? '解码: ' + decode : ''}`}
      actions={<CopyBtn text={encode} label="复制编码" />}
    />
  )
}
