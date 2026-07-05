import { useEffect, useState } from 'react'
import type { ToolProps } from './shared'
import { DualPane, CopyBtn } from './shared'

const ALGOS = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const
const enc = new TextEncoder()

async function digest(algo: string, text: string): Promise<string> {
  const buf = await crypto.subtle.digest(algo, enc.encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export default function Hash({ input, onInput }: ToolProps) {
  const [hashes, setHashes] = useState<Record<string, string>>({})
  const [hmacKey, setHmacKey] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!input) {
      setHashes({})
      return
    }
    ;(async () => {
      const result: Record<string, string> = {}
      // MD5 用纯 JS 实现(Web Crypto 不支持)
      result['MD5'] = md5(input)
      for (const a of ALGOS) {
        result[a] = await digest(a, input)
      }
      if (hmacKey) {
        try {
          const key = await crypto.subtle.importKey(
            'raw',
            enc.encode(hmacKey),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          )
          const sig = await crypto.subtle.sign('HMAC', key, enc.encode(input))
          result['HMAC-SHA256'] = [...new Uint8Array(sig)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) setHashes(result)
    })()
    return () => {
      cancelled = true
    }
  }, [input, hmacKey])

  const out = Object.entries(hashes)
    .map(([k, v]) => `${k}\n${v}`)
    .join('\n\n')

  return (
    <DualPane
      inputLabel="输入文本"
      outputLabel="哈希结果"
      input={input}
      onInput={onInput}
      inputPlaceholder="输入文本自动计算哈希"
      output={out}
      actions={
        <>
          <input
            value={hmacKey}
            onChange={(e) => setHmacKey(e.target.value)}
            placeholder="HMAC 密钥(可选)"
            className="rounded-btn border border-line bg-bg-surface px-2 py-1 text-caption text-ink-primary outline-none focus:border-accent"
          />
          <CopyBtn text={out} label="复制全部" />
        </>
      }
    />
  )
}

// MD5 实现(Joseph Myers 公开域算法,精简版)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function md5(str: string): string {
  function rh(n: number) {
    let s = '',
      j: number
    for (j = 0; j <= 3; j++)
      s += ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16)
    return s
  }
  function ad(x: number, y: number) {
    const l = (x & 0xffff) + (y & 0xffff)
    const m = (x >> 16) + (y >> 16) + (l >> 16)
    return (m << 16) | (l & 0xffff)
  }
  function rl(n: number, c: number) {
    return (n << c) | (n >>> (32 - c))
  }
  function cm(q: number, a: number, b: number, x: number, s: number, t: number) {
    return ad(rl(ad(ad(a, q), ad(x, t)), s), b)
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cm((b & c) | (~b & d), a, b, x, s, t)
  }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cm((b & d) | (c & ~d), a, b, x, s, t)
  }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cm(b ^ c ^ d, a, b, x, s, t)
  }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cm(c ^ (b | ~d), a, b, x, s, t)
  }
  function cb(s: string) {
    const n = s.length,
      x: number[] = []
    for (let i2 = 0; i2 < n; i2++) x[i2 >> 2] = (x[i2 >> 2] || 0) | (s.charCodeAt(i2) << ((i2 % 4) * 8))
    x[n >> 2] = (x[n >> 2] || 0) | (0x80 << ((n % 4) * 8))
    x[(((n + 8) >> 6) + 1) * 16] = n * 8
    let a = 0x67452301,
      b = 0xefcdab89,
      c = 0x98badcfe,
      d = 0x10325476
    for (let j = 0; j < x.length; j += 16) {
      const oa = a,
        ob = b,
        oc = c,
        od = d
      a = ff(a, b, c, d, x[j], 7, 0xd76aa478)
      d = ff(d, a, b, c, x[j + 1], 12, 0xe8c7b756)
      c = ff(c, d, a, b, x[j + 2], 17, 0x242070db)
      b = ff(b, c, d, a, x[j + 3], 22, 0xc1bdceee)
      a = ff(a, b, c, d, x[j + 4], 7, 0xf57c0faf)
      d = ff(d, a, b, c, x[j + 5], 12, 0x4787c62a)
      c = ff(c, d, a, b, x[j + 6], 17, 0xa8304613)
      b = ff(b, c, d, a, x[j + 7], 22, 0xfd469501)
      a = ff(a, b, c, d, x[j + 8], 7, 0x698098d8)
      d = ff(d, a, b, c, x[j + 9], 12, 0x8b44f7af)
      c = ff(c, d, a, b, x[j + 10], 17, 0xffff5bb1)
      b = ff(b, c, d, a, x[j + 11], 22, 0x895cd7be)
      a = ff(a, b, c, d, x[j + 12], 7, 0x6b901122)
      d = ff(d, a, b, c, x[j + 13], 12, 0xfd987193)
      c = ff(c, d, a, b, x[j + 14], 17, 0xa679438e)
      b = ff(b, c, d, a, x[j + 15], 22, 0x49b40821)
      a = gg(a, b, c, d, x[j + 1], 5, 0xf61e2562)
      d = gg(d, a, b, c, x[j + 6], 9, 0xc040b340)
      c = gg(c, d, a, b, x[j + 11], 14, 0x265e5a51)
      b = gg(b, c, d, a, x[j], 20, 0xe9b6c7aa)
      a = gg(a, b, c, d, x[j + 5], 5, 0xd62f105d)
      d = gg(d, a, b, c, x[j + 10], 9, 0x2441453)
      c = gg(c, d, a, b, x[j + 15], 14, 0xd8a1e681)
      b = gg(b, c, d, a, x[j + 4], 20, 0xe7d3fbc8)
      a = gg(a, b, c, d, x[j + 9], 5, 0x21e1cde6)
      d = gg(d, a, b, c, x[j + 14], 9, 0xc33707d6)
      c = gg(c, d, a, b, x[j + 3], 14, 0xf4d50d87)
      b = gg(b, c, d, a, x[j + 8], 20, 0x455a14ed)
      a = gg(a, b, c, d, x[j + 13], 5, 0xa9e3e905)
      d = gg(d, a, b, c, x[j + 2], 9, 0xfcefa3f8)
      c = gg(c, d, a, b, x[j + 7], 14, 0x676f02d9)
      b = gg(b, c, d, a, x[j + 12], 20, 0x8d2a4c8a)
      a = hh(a, b, c, d, x[j + 5], 4, 0xfffa3942)
      d = hh(d, a, b, c, x[j + 8], 11, 0x8771f681)
      c = hh(c, d, a, b, x[j + 11], 16, 0x6d9d6122)
      b = hh(b, c, d, a, x[j + 14], 23, 0xfde5380c)
      a = hh(a, b, c, d, x[j + 1], 4, 0xa4beea44)
      d = hh(d, a, b, c, x[j + 4], 11, 0x4bdecfa9)
      c = hh(c, d, a, b, x[j + 7], 16, 0xf6bb4b60)
      b = hh(b, c, d, a, x[j + 10], 23, 0xbebfbc70)
      a = hh(a, b, c, d, x[j + 13], 4, 0x289b7ec6)
      d = hh(d, a, b, c, x[j], 11, 0xeaa127fa)
      c = hh(c, d, a, b, x[j + 3], 16, 0xd4ef3085)
      b = hh(b, c, d, a, x[j + 6], 23, 0x4881d05)
      a = hh(a, b, c, d, x[j + 9], 4, 0xd9d4d039)
      d = hh(d, a, b, c, x[j + 12], 11, 0xe6db99e5)
      c = hh(c, d, a, b, x[j + 15], 16, 0x1fa27cf8)
      b = hh(b, c, d, a, x[j + 2], 23, 0xc4ac5665)
      a = ii(a, b, c, d, x[j], 6, 0xf4292244)
      d = ii(d, a, b, c, x[j + 7], 10, 0x432aff97)
      c = ii(c, d, a, b, x[j + 14], 15, 0xab9423a7)
      b = ii(b, c, d, a, x[j + 5], 21, 0xfc93a039)
      a = ii(a, b, c, d, x[j + 12], 6, 0x655b59c3)
      d = ii(d, a, b, c, x[j + 3], 10, 0x8f0ccc92)
      c = ii(c, d, a, b, x[j + 10], 15, 0xffeff47d)
      b = ii(b, c, d, a, x[j + 1], 21, 0x85845dd1)
      a = ii(a, b, c, d, x[j + 8], 6, 0x6fa87e4f)
      d = ii(d, a, b, c, x[j + 15], 10, 0xfe2ce6e0)
      c = ii(c, d, a, b, x[j + 6], 15, 0xa3014314)
      b = ii(b, c, d, a, x[j + 13], 21, 0x4e0811a1)
      a = ii(a, b, c, d, x[j + 4], 6, 0xf7537e82)
      d = ii(d, a, b, c, x[j + 11], 10, 0xbd3af235)
      c = ii(c, d, a, b, x[j + 2], 15, 0x2ad7d2bb)
      b = ii(b, c, d, a, x[j + 9], 21, 0xeb86d391)
      a = ad(a, oa)
      b = ad(b, ob)
      c = ad(c, oc)
      d = ad(d, od)
    }
    return rh(a) + rh(b) + rh(c) + rh(d)
  }
  return cb(unescape(encodeURIComponent(str)))
}
