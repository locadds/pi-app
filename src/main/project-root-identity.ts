import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export interface ProjectRootIdentityV2 {
  readonly schemaVersion: 2
  readonly canonicalRoot: string
  readonly device: string
  readonly inode: string
  readonly birthtimeNs: string
  readonly digest: string
}

/** Stable identity for the directory entity, not merely its pathname. */
export function readProjectRootIdentityV2(cwd: string): ProjectRootIdentityV2 {
  const lexical = resolve(String(cwd || '').trim())
  if (!existsSync(lexical)) throw new Error('PROJECT_ROOT_MISSING')
  const linkInfo = lstatSync(lexical)
  if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) throw new Error('PROJECT_ROOT_INVALID')
  const canonicalRoot = filesystemExecutionPathV2(realpathSync.native(lexical))
  const stats = statSync(lexical, { bigint: true })
  if (!stats.isDirectory()) throw new Error('PROJECT_ROOT_INVALID')
  const birthtimeNs = (stats as unknown as { birthtimeNs?: bigint }).birthtimeNs
    ?? BigInt(stats.birthtimeMs) * 1_000_000n
  const payload = {
    schemaVersion: 2 as const,
    canonicalRoot,
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    birthtimeNs: birthtimeNs.toString(10),
  }
  const digestPayload = {
    ...payload,
    // Paths used for execution preserve their real filesystem spelling. Only
    // the identity comparison key is case-folded where the filesystem is
    // actually case-insensitive.
    canonicalRoot: projectRootComparisonKeyV2(canonicalRoot),
  }
  return Object.freeze({
    ...payload,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(digestPayload)).digest('hex')}`,
  })
}

/** Execution path spelling. It must never be replaced by a comparison key. */
export function filesystemExecutionPathV2(value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  let normalized = resolve(raw).replace(/\\/g, '/')
  if (normalized.length > 1 && !/^[a-zA-Z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, '')
  return normalized
}

/** Comparison-only key. Never use this value as an execution cwd. */
export function projectRootComparisonKeyV2(value: string): string {
  const normalized = filesystemExecutionPathV2(value)
  if (process.platform !== 'win32') return normalized
  if (!/^\/\/(?:wsl\.localhost|wsl\$)\//i.test(normalized)) return normalized.toLowerCase()

  const parts = normalized.replace(/^\/+/, '').split('/')
  if (parts.length < 2) return normalized
  const server = parts[0].toLowerCase() === 'wsl$' ? 'wsl.localhost' : parts[0].toLowerCase()
  const distro = parts[1].toLowerCase()
  return `//${server}/${distro}${parts.length > 2 ? `/${parts.slice(2).join('/')}` : ''}`
}
