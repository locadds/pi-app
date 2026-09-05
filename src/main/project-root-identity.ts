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
  const canonicalRoot = pathKey(realpathSync.native(lexical))
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
  return Object.freeze({
    ...payload,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
  })
}

function pathKey(value: string): string {
  let normalized = resolve(value).replace(/\\/g, '/')
  if (normalized.length > 1 && !/^[a-zA-Z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
