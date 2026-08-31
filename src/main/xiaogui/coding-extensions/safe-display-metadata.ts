const MAX_DISPLAY_METADATA_LENGTH = 256

const ABSOLUTE_WINDOWS_PATH = /(?:[a-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:^|[\s("'=,\[])\/\/[^/\s]+\/[^/\s]+)/i
const FILE_URL = /\bfile:\/{1,3}/i
const ABSOLUTE_POSIX_PATH = /(?:^|[^a-z0-9._/])\/(?!\/)[^/\s"'<>]+(?:\/[^\s"'<>]*)?/i
const KNOWN_POSIX_ROOT = /(?:^|[\s("'=:\[,])\/(?:etc|home|root|tmp|usr|var|opt|srv|mnt|media|workspace|workspaces|private|volumes)(?:\/|\b)/i
const CREDENTIAL_ASSIGNMENT = /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)\b(?:\s*[:=]|\s+)\s*\S+/i
const AUTH_SCHEME = /\b(?:bearer|basic)\s+\S+/i
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i
const COMMON_SECRET_PREFIX = /\b(?:sk-[a-z0-9_-]{8,}|gh[opsu]_[a-z0-9]{8,}|xox[baprs]-[a-z0-9-]{8,}|akia[0-9a-z]{12,})\b/i

/**
 * Main-only boundary for strings rendered in an authoritative permission dialog.
 * Invalid metadata is omitted so the containing permission intent fails closed.
 */
export function safeCodingPermissionDisplayMetadata(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Check raw bytes first: whitespace normalisation must not conceal controls.
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined

  const normalized = value.trim().replace(/[ \t]+/g, ' ')
  if (!normalized || normalized.length > MAX_DISPLAY_METADATA_LENGTH) return undefined
  if (
    ABSOLUTE_WINDOWS_PATH.test(normalized)
    || FILE_URL.test(normalized)
    || ABSOLUTE_POSIX_PATH.test(normalized)
    || KNOWN_POSIX_ROOT.test(normalized)
    || CREDENTIAL_ASSIGNMENT.test(normalized)
    || AUTH_SCHEME.test(normalized)
    || URL_USERINFO.test(normalized)
    || COMMON_SECRET_PREFIX.test(normalized)
  ) return undefined

  return normalized
}
