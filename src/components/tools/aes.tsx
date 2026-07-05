import { useState } from 'react'
import type { ToolProps } from './shared'
import { DualPane, CopyBtn, ActionBtn } from './shared'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function aesEncrypt(plain: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const keyBytes = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', enc.encode(key)),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyBytes, enc.encode(plain))
  const combined = new Uint8Array(iv.length + ct.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ct), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function aesDecrypt(b64: string, key: string): Promise<string> {
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ct = combined.slice(12)
  const keyBytes = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', enc.encode(key)),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyBytes, ct)
  return dec.decode(pt)
}

export default function Aes({ input, onInput }: ToolProps) {
  const [key, setKey] = useState('')
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')

  const enc_ = async () => {
    setErr('')
    try {
      setOut(await aesEncrypt(input, key || 'default'))
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const dec_ = async () => {
    setErr('')
    try {
      setOut(await aesDecrypt(input, key || 'default'))
    } catch (e) {
      setErr('解密失败:' + (e as Error).message)
    }
  }

  return (
    <DualPane
      inputLabel="明文 / 密文(Base64)"
      outputLabel="结果"
      input={input}
      onInput={onInput}
      output={err || out}
      actions={
        <>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="密钥"
            type="password"
            className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary outline-none focus:border-accent"
          />
          <ActionBtn onClick={enc_} primary>加密</ActionBtn>
          <ActionBtn onClick={dec_}>解密</ActionBtn>
          <CopyBtn text={out} label="复制" />
        </>
      }
    />
  )
}
