// P2 sensitivity scanner — pure module (no `electron` import).
//
// Classifies attachment text for outbound safety. Detects:
//   - `.env`-style KEY=VALUE assignments that look like secrets
//   - PEM / private-key markers (-----BEGIN ... PRIVATE KEY-----)
//   - AWS-style access keys (AKIA...) and secret keys (40-char base64)
//
// Restricted content is NEVER sent to the provider (fail-closed). The scanner
// returns a safe reason string (no raw secret) for the UI/audit. It also
// exposes `redactForContext` which strips detected secrets from a text blob;
// but a restricted attachment is blocked outright, not redacted-then-sent —
// redaction is a defense-in-depth used only for non-blocking contexts (e.g.
// building a preview or an error message that might include a fragment).

import type { AiAttachmentSensitivity } from './ai-context-types.js'

export interface AiSensitivityResult {
  sensitivity: AiAttachmentSensitivity
  /** Safe reason (no raw secret) when restricted. */
  reason?: string
}

/**
 * Classify attachment text. Returns `restricted` if any secret marker matches;
 * the reason is a short, safe label — never the matched secret itself.
 */
export function classifySensitivity(text: string): AiSensitivityResult {
  // PEM / private-key blocks.
  if (PEM_PRIVATE_KEY.test(text)) {
    return { sensitivity: 'restricted', reason: '检测到 PEM 私钥标记' }
  }
  // .env-style assignments where the value looks like a secret (long, or a
  // known key-name pattern). Catches `OPENAI_API_KEY=sk-...`, `AWS_SECRET_ACCESS_KEY=...`, etc.
  const envMatch = ENV_SECRET_ASSIGNMENT.exec(text)
  if (envMatch) {
    return { sensitivity: 'restricted', reason: `检测到 .env 赋值（${envMatch[1]}）` }
  }
  // AWS access key id (AKIA + 16 chars).
  if (AWS_ACCESS_KEY_ID.test(text)) {
    return { sensitivity: 'restricted', reason: '检测到 AWS 访问密钥 ID' }
  }
  // AWS secret access key assignment (40-char base64 after a secret-ish key).
  const awsSecret = AWS_SECRET_ASSIGNMENT.exec(text)
  if (awsSecret) {
    return { sensitivity: 'restricted', reason: `检测到 AWS 风格密钥（${awsSecret[1]}）` }
  }
  return { sensitivity: 'normal' }
}

/**
 * Strip detected secrets from a text fragment (defense-in-depth). Replaces each
 * match with `••••`. Used for previews/error snippets, NOT for unblocking a
 * restricted attachment — restricted attachments are blocked, never sent.
 */
export function redactForContext(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY, '-----BEGIN •••• PRIVATE KEY-----')
    .replace(ENV_SECRET_ASSIGNMENT, '$1=••••')
    .replace(AWS_ACCESS_KEY_ID, 'AKIA••••')
    .replace(AWS_SECRET_ASSIGNMENT, '$1=••••')
}

// --- Detection patterns ----------------------------------------------------

const PEM_PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/i

/**
 * .env-style `KEY=value` where KEY contains a secret hint (key, token, secret,
 * password, passwd, pwd, credential) and value is non-empty and not obviously
 * a placeholder. Captures the KEY name for the safe reason.
 */
const ENV_SECRET_ASSIGNMENT =
  /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/m

/** AWS access key id: AKIA followed by 16 uppercase alphanumerics. */
const AWS_ACCESS_KEY_ID = /AKIA[0-9A-Z]{16}/

/**
 * AWS-style secret assignment: a secret-ish key name followed by a 40-char
 * base64 value. Catches `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.
 */
const AWS_SECRET_ASSIGNMENT =
  /(?:^|\n)\s*([a-z0-9_]*(?:secret|access[_-]?key)[a-z0-9_]*)\s*[:=]\s*([A-Za-z0-9/+=]{40})(?:\s|$)/i
