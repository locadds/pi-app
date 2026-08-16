import { createHmac, randomBytes } from 'node:crypto'

const LOCAL_SURROGATE_KEY = randomBytes(32)
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isSafeAcpOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !containsSensitiveText(value)
}

export function localRuntimeSurrogate(value: string, scopeDigest: string): string {
  const digest = createHmac('sha256', LOCAL_SURROGATE_KEY)
    .update('xiaogui-kimi-acp-runtime-session-v1\0')
    .update(scopeDigest)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 32)
  return `xgrs_${digest}`
}

export function digestSafeText(value: unknown, maxLength = 160): string {
  const source = typeof value === 'string' ? value : String(value ?? '')
  const redacted = source
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\bfile:\/\/[^\r\n]*/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/g, '[redacted]')
    .replace(/(?<!https:)(?<!http:)\/(?!\/)[^\r\n]*/g, '[redacted]')
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(ghp|github_pat|sk|xox[baprs])-?[A-Za-z0-9_]{16,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return redacted.length <= maxLength ? redacted : redacted.slice(0, maxLength)
}

function containsSensitiveText(value: string): boolean {
  return /[A-Za-z]:[\\/]|\\\\|file:\/\/|https?:\/\/(?:127\.0\.0\.1|localhost)|\b(?:token|secret|password)\s*[:=]/i.test(value)
}
