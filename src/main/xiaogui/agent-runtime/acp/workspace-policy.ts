import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

export interface KimiAcpAllowedFileV1 {
  relativePath: string
  contentDigest: string
}

export interface PreparedKimiAcpWorkspacePolicyV1 {
  readonly rootPath: string
  readonly allowedRelativePaths: readonly string[]
  readTextFile(requestedPath: string): { content: string; contentDigest: string }
  writeTextFile(requestedPath: string, content: string): { contentDigest: string; candidateDigest: string }
}

interface FileIdentity {
  readonly realPath: string
  readonly dev: bigint
  readonly ino: bigint
  readonly contentDigest: string
}

const identities = new WeakMap<PreparedKimiAcpWorkspacePolicyV1, Map<string, FileIdentity>>()

export class KimiAcpWorkspacePolicyError extends Error {
  readonly reasonCode: string

  constructor(reasonCode: string) {
    super(reasonCode)
    this.name = 'KimiAcpWorkspacePolicyError'
    this.reasonCode = reasonCode
  }
}

export function prepareKimiAcpWorkspacePolicy(
  rootPath: string,
  allowedFiles: readonly KimiAcpAllowedFileV1[],
): PreparedKimiAcpWorkspacePolicyV1 {
  if (allowedFiles.length === 0) throw new KimiAcpWorkspacePolicyError('WORKSPACE_ALLOWLIST_EMPTY')
  const lexicalRoot = resolve(rootPath)
  const realRoot = safeRealpath(lexicalRoot, 'WORKSPACE_ROOT_UNAVAILABLE')
  if (pathKey(lexicalRoot) !== pathKey(realRoot)) throw new KimiAcpWorkspacePolicyError('WORKSPACE_ROOT_ALIAS')

  const frozen = new Map<string, FileIdentity>()
  for (const file of allowedFiles) {
    const target = resolveRequested(realRoot, file.relativePath, true)
    const identity = readIdentity(realRoot, target.realPath)
    if (identity.contentDigest !== file.contentDigest) throw new KimiAcpWorkspacePolicyError('WORKSPACE_ALLOWED_FILE_DIGEST_MISMATCH')
    frozen.set(pathKey(identity.realPath), identity)
  }

  const policy: PreparedKimiAcpWorkspacePolicyV1 = Object.freeze({
    rootPath: realRoot,
    allowedRelativePaths: allowedFiles.map((file) => file.relativePath),
    readTextFile(requestedPath: string) {
      const identity = verifyAllowed(policy, requestedPath)
      const buffer = readFileSync(identity.realPath)
      return { content: buffer.toString('utf8'), contentDigest: digestBytes(buffer) }
    },
    writeTextFile(requestedPath: string, content: string) {
      const before = verifyAllowed(policy, requestedPath)
      const next = Buffer.from(content, 'utf8')
      const nextDigest = digestBytes(next)
      const temporaryPath = join(dirname(before.realPath), `.xiaogui-acp-${process.pid}-${Date.now()}.tmp`)
      try {
        writeFileSync(temporaryPath, next, { flag: 'wx' })
        renameSync(temporaryPath, before.realPath)
      } catch (error) {
        try {
          unlinkSync(temporaryPath)
        } catch {
          // ignore cleanup failure
        }
        throw error instanceof KimiAcpWorkspacePolicyError ? error : new KimiAcpWorkspacePolicyError('WORKSPACE_WRITE_FAILED')
      }
      const after = readIdentity(realRoot, before.realPath)
      frozen.set(pathKey(after.realPath), after)
      return {
        contentDigest: nextDigest,
        candidateDigest: digestJson({ path: safeRelative(realRoot, after.realPath), contentDigest: nextDigest }),
      }
    },
  })
  identities.set(policy, frozen)
  return policy
}

function verifyAllowed(policy: PreparedKimiAcpWorkspacePolicyV1, requestedPath: string): FileIdentity {
  const target = resolveRequested(policy.rootPath, requestedPath, false)
  const current = readIdentity(policy.rootPath, target.realPath)
  const allowed = identities.get(policy)?.get(pathKey(current.realPath))
  if (!allowed) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_NOT_ALLOWLISTED')
  if (current.dev !== allowed.dev || current.ino !== allowed.ino) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_IDENTITY_CHANGED')
  if (current.contentDigest !== allowed.contentDigest) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_DIGEST_CHANGED')
  return current
}

function resolveRequested(rootPath: string, requestedPath: string, allowConfiguredOnly: boolean): { realPath: string } {
  if (
    requestedPath.length === 0 ||
    requestedPath !== requestedPath.trim() ||
    requestedPath.includes('\0') ||
    requestedPath.includes(':') ||
    hasTraversal(requestedPath) ||
    win32.isAbsolute(requestedPath) ||
    posix.isAbsolute(requestedPath)
  ) {
    throw new KimiAcpWorkspacePolicyError(allowConfiguredOnly ? 'WORKSPACE_ALLOWLIST_PATH_INVALID' : 'WORKSPACE_REQUEST_PATH_INVALID')
  }
  const lexical = resolve(rootPath, requestedPath.replace(/[\\/]/g, sep))
  if (!isInside(rootPath, lexical)) throw new KimiAcpWorkspacePolicyError('WORKSPACE_REQUEST_OUTSIDE_ROOT')
  const realPath = safeRealpath(lexical, 'WORKSPACE_FILE_UNAVAILABLE')
  if (!isInside(rootPath, realPath)) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_OUTSIDE_ROOT')
  if (pathKey(lexical) !== pathKey(realPath)) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_ALIAS')
  return { realPath }
}

function readIdentity(rootPath: string, realPath: string): FileIdentity {
  let info
  try {
    info = lstatSync(realPath, { bigint: true })
  } catch {
    throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_UNAVAILABLE')
  }
  if (info.isSymbolicLink()) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_ALIAS')
  if (!info.isFile()) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_NOT_ORDINARY')
  if (info.nlink !== 1n) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_HARDLINK')
  const descriptor = openSync(realPath, 'r')
  let stable
  let buffer
  try {
    stable = fstatSync(descriptor, { bigint: true })
    buffer = readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  if (stable.ino <= 0n) throw new KimiAcpWorkspacePolicyError('WORKSPACE_FILE_IDENTITY_UNAVAILABLE')
  return {
    realPath,
    dev: stable.dev,
    ino: stable.ino,
    contentDigest: digestBytes(buffer),
  }
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/).includes('..')
}

function isInside(rootPath: string, candidate: string): boolean {
  const child = relative(rootPath, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function safeRealpath(path: string, reasonCode: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    throw new KimiAcpWorkspacePolicyError(reasonCode)
  }
}

function safeRelative(rootPath: string, candidate: string): string {
  return relative(rootPath, candidate).split(sep).join('/')
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digestJson(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'))
}
