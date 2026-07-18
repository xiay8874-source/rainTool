// P4 MCP shared pure helpers — fingerprint + loopback URL validation.
//
// Centralized so the manager (eligibility at add time) and the config
// repository (validateServerEntry at read time) enforce the SAME canonical
// fingerprint form and loopback rules. No cycle: this module imports only
// node:crypto, nothing from the manager or repository.
//
// Locked P4 contract:
//   - trusted-built-in:  sha256("trusted-built-in:raintool-mcp")  (stable label)
//   - user-stdio:         sha256(command + "\0" + args.join("\0"))  (ordered)
//   - user-loopback:      sha256(canonical URL: {protocol,hostname,port,pathname})
//
// isLoopbackUrl: http only, 127.0.0.1/::1/localhost, port present (1-65535),
// no credentials/query/hash, no '..' in pathname.

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

/** sha256 hex of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Stable-label fingerprint for the trusted built-in (launcher path never persisted). */
export function FINGERPRINT_BUILT_IN(): string {
  return sha256Hex('trusted-built-in:raintool-mcp')
}

/**
 * Canonical fingerprint of a stdio command + args. Form:
 *   sha256(command + "\0" + args.join("\0"))
 * Ordered — a single arg change produces a different fingerprint, which
 * invalidates any pending activation nonce bound to the prior fingerprint.
 */
export function fingerprintStdio(command: string, args: string[]): string {
  return sha256Hex([command, ...args].join('\0'))
}

/**
 * Canonical fingerprint of a loopback URL. Form:
 *   sha256(JSON.stringify({ protocol, hostname, port, pathname }))
 * Credentials/query/hash are stripped (they'd have been rejected by
 * isLoopbackUrl upstream, but the canonical form is stable + minimal).
 */
export function fingerprintLoopback(url: string): string {
  const u = new URL(url)
  return sha256Hex(JSON.stringify({
    protocol: u.protocol,
    hostname: u.hostname.toLowerCase(),
    port: u.port,
    pathname: u.pathname,
  }))
}

/**
 * True iff the URL is a P4-eligible loopback MCP endpoint:
 *   - protocol: http:  (no https/tls surface in P4 loopback)
 *   - host: 127.0.0.1, ::1, or localhost
 *   - port: present, 1–65535
 *   - no username/password (credentials)
 *   - no search (query)
 *   - no hash (fragment)
 *   - no '..' in pathname
 */
export function isLoopbackUrl(raw: string): boolean {
  // Path-traversal hardening. Reject ANY form of dot-segment traversal —
  // literal or percent-encoded — in the raw URL, BEFORE and AFTER new URL()
  // normalization. new URL() normalizes literal '../' away (e.g.
  // '/a/../b' → '/b'), so a post-parse check alone is insufficient. A loopback
  // MCP endpoint is a fixed local address and has no legitimate need for
  // encoded path separators, encoded dots, or dot-segments.
  const lower = raw.toLowerCase()
  // Layer 1: reject any percent-encoded dot (%2e) or slash/backslash
  // (%2f / %5c) anywhere in the raw URL. Catches %2e%2e/, %2e./, .%2e/,
  // ..%2f, ..%5c, and bare %2f / %5c.
  if (lower.includes('%2e') || lower.includes('%2f') || lower.includes('%5c')) {
    return false
  }
  // Layer 2: reject literal dot-segment patterns in the raw string. Catches
  // '../', '..\', '/..', '\..' at any position (before URL normalization).
  if (lower.includes('../') || lower.includes('..\\') ||
      lower.includes('/..') || lower.includes('\\..')) {
    return false
  }
  let u: URL
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'http:') return false
  // Node's URL.hostname keeps brackets for IPv6 ("[::1]"), so accept both forms.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') return false
  if (!u.port || u.port === '0') return false
  const port = Number(u.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (u.username || u.password) return false
  if (u.search) return false
  if (u.hash) return false
  // Layer 3: split the parsed (normalized) pathname into segments and reject
  // any '.' or '..' segment. Defense-in-depth for a future URL parser revision
  // that does not normalize dot-segments.
  for (const seg of u.pathname.split('/')) {
    if (seg === '..' || seg === '.') return false
  }
  return true
}

/**
 * Bounded stderr capture sink. Holds at most `maxBytes` UTF-8 BYTES of the
 * TAIL of stderr (most recent output). The bound is in BYTES
 * (Buffer.byteLength), NOT string length — a multi-byte UTF-8 char would
 * otherwise let `line.length` under-count and overflow the cap. Slicing stays
 * on UTF-8 char boundaries by re-encoding the truncated buffer.
 *
 * MAIN-INTERNAL ONLY. The sink never crosses to config, event, or the
 * renderer — connect()'s catch composes `reason = sanitizeError(error)` only.
 * No stderr (even redacted) is included in the outward error. The sink exists
 * solely so a future main-side debug surface has a bounded tail; the outward
 * error never reads it.
 */
export class BoundedStderrSink {
  private buf = ''
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  /** Append a chunk (string or Buffer). Keeps the tail within maxBytes. */
  append(chunk: string | Buffer): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // Normalize newlines + drop empty/whitespace-only lines so the buffer
    // holds meaningful lines only.
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/\r$/, '')
      if (!trimmed.trim()) continue
      const lineBytes = Buffer.byteLength(trimmed + '\n', 'utf8')
      if (this.bytes + lineBytes > this.maxBytes) {
        // Evict oldest lines until the new one fits. Re-encode on UTF-8
        // boundaries so a multi-byte char is never split.
        const keep = this.maxBytes - lineBytes
        if (keep <= 0) {
          // New line alone exceeds the cap: keep its tail within the cap.
          this.buf = tailUtf8(trimmed + '\n', this.maxBytes)
          this.bytes = Buffer.byteLength(this.buf, 'utf8')
          continue
        }
        this.buf = tailUtf8(this.buf, keep)
        this.bytes = Buffer.byteLength(this.buf, 'utf8')
      }
      this.buf += trimmed + '\n'
      this.bytes += lineBytes
    }
  }

  /** The captured tail (main-internal only). */
  value(): string {
    return this.buf
  }
}

/** Keep the UTF-8 tail of `text` within `maxBytes`, on char boundaries. */
function tailUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let cut = buf.length - maxBytes
  // Walk forward to the next UTF-8 char boundary (a lead byte: 0xxxxxxx /
  // 11xxxxxx). Continuation bytes (10xxxxxx) must not start a char.
  while (cut < buf.length && (buf[cut] & 0xc0) === 0x80) cut++
  return buf.subarray(cut).toString('utf8')
}
