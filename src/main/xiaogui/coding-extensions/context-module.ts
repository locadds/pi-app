import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

import type {
  CodingContextAgentPayloadV1,
  CodingContextSnapshotRequestV1,
  CodingContextSnapshotV1,
} from '@shared/xiaogui-coding-extension-pack'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { resolvePathUnderWorkspace } from '../../workspace-fs'
import type { ProjectWorkspaceResolverV1 } from '../task-hub/attempt-workspace'

const CONTEXT_SOURCE_LIMIT = 20
const CONTEXT_SNAPSHOT_BYTE_LIMIT = 1024 * 1024
const CONTEXT_HASH_BYTE_LIMIT = 64 * 1024 * 1024
const CONTEXT_SNAPSHOT_TTL_MS = 10 * 60 * 1000
const CONTEXT_STORE_SNAPSHOT_LIMIT = 64
const CONTEXT_STORE_BYTE_LIMIT = 8 * 1024 * 1024

interface PrivateContextSnapshotV1 {
  readonly address: SessionAddressV1
  readonly expiresAt: number
  readonly byteLength: number
  readonly sources: CodingContextAgentPayloadV1['sources']
}

export interface CodingContextModuleOptionsV1 {
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly scopeLookup: SessionScopeLookupV1
  readonly now?: () => number
  readonly ttlMs?: number
  readonly maxSnapshots?: number
  readonly maxStoredBytes?: number
}

/** Main-process authority for project-bound, one-turn Coding context. */
export class CodingContextModuleV1 {
  private readonly snapshots = new Map<string, PrivateContextSnapshotV1>()
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxSnapshots: number
  private readonly maxStoredBytes: number
  private storedBytes = 0

  constructor(private readonly options: CodingContextModuleOptionsV1) {
    this.now = options.now ?? Date.now
    this.ttlMs = positiveInteger(options.ttlMs) ? options.ttlMs! : CONTEXT_SNAPSHOT_TTL_MS
    this.maxSnapshots = positiveInteger(options.maxSnapshots)
      ? options.maxSnapshots!
      : CONTEXT_STORE_SNAPSHOT_LIMIT
    this.maxStoredBytes = positiveInteger(options.maxStoredBytes)
      ? options.maxStoredBytes!
      : CONTEXT_STORE_BYTE_LIMIT
  }

  async snapshot(request: CodingContextSnapshotRequestV1): Promise<CodingContextSnapshotV1> {
    const scope = await this.options.scopeLookup.lookup(request.address)
    if (scope.kind !== 'FOUND' || scope.scope.sessionMode !== 'CODING') {
      throw new Error('CODING_CONTEXT_SCOPE_NOT_AUTHORIZED')
    }
    if (request.relativePaths.length === 0) throw new Error('CODING_CONTEXT_SOURCE_REQUIRED')
    if (request.relativePaths.length > CONTEXT_SOURCE_LIMIT) {
      throw new Error('CODING_CONTEXT_SOURCE_LIMIT_EXCEEDED')
    }

    const workspaceRoot = await this.options.projectResolver.resolveProjectRoot(request.address.projectId)
    const canonicalWorkspaceRoot = realpathSync(workspaceRoot)
    let totalBytes = 0
    let includedBytes = 0
    let truncated = false
    const sources: CodingContextSnapshotV1['sources'][number][] = []
    const privateSources: CodingContextAgentPayloadV1['sources'][number][] = []
    for (const input of request.relativePaths) {
      if (isAbsolute(input)) throw new Error('CODING_CONTEXT_RELATIVE_PATH_REQUIRED')
      const resolved = resolvePathUnderWorkspace(canonicalWorkspaceRoot, input)
      if (!resolved.ok) {
        throw new Error(
          resolved.error === 'outside_workspace'
            ? 'CODING_CONTEXT_OUTSIDE_WORKSPACE'
            : 'CODING_CONTEXT_SOURCE_INVALID',
        )
      }
      if (!existsSync(resolved.abs)) throw new Error('CODING_CONTEXT_SOURCE_NOT_FOUND')
      const stat = statSync(resolved.abs)
      if (!stat.isFile()) throw new Error('CODING_CONTEXT_FILE_REQUIRED')
      totalBytes += stat.size
      if (totalBytes > CONTEXT_HASH_BYTE_LIMIT) {
        throw new Error('CODING_CONTEXT_BYTE_LIMIT_EXCEEDED')
      }
      const remaining = Math.max(0, CONTEXT_SNAPSHOT_BYTE_LIMIT - includedBytes)
      const bytes = readFileSync(resolved.abs).subarray(0, remaining)
      if (bytes.includes(0)) throw new Error('CODING_CONTEXT_TEXT_REQUIRED')
      const sourceTruncated = bytes.length < stat.size
      truncated ||= sourceTruncated
      includedBytes += bytes.length
      const relativePath = relative(canonicalWorkspaceRoot, resolved.abs).split(sep).join('/')
      const content = bytes.toString('utf8')
      sources.push({
        relativePath,
        byteLength: stat.size,
        contentDigest: await sha256File(resolved.abs),
        contentSummary: {
          lineCount: content ? content.split(/\r?\n/).length : 0,
          includedBytes: bytes.length,
          truncated: sourceTruncated,
        },
      })
      privateSources.push({ relativePath, content, truncated: sourceTruncated })
    }

    const snapshotId = `xgctx_${randomUUID()}`
    this.pruneExpired()
    if (
      this.snapshots.size >= this.maxSnapshots ||
      this.storedBytes + includedBytes > this.maxStoredBytes
    ) throw new Error('CODING_CONTEXT_STORE_LIMIT_EXCEEDED')
    this.snapshots.set(snapshotId, {
      address: request.address,
      expiresAt: this.now() + this.ttlMs,
      byteLength: includedBytes,
      sources: Object.freeze(privateSources),
    })
    this.storedBytes += includedBytes
    const timer = setTimeout(() => this.deleteSnapshot(snapshotId), this.ttlMs)
    timer.unref?.()
    this.expiryTimers.set(snapshotId, timer)
    return {
      schemaVersion: 1,
      snapshotId,
      sources,
      symbolService: 'UNAVAILABLE',
      diagnosticService: 'UNAVAILABLE',
      resolutionMode: 'CONTROLLED_TEXT_FALLBACK',
      degradationReason: 'SYMBOL_SERVICE_UNAVAILABLE',
      diagnosticDegradationReason: 'DIAGNOSTIC_SERVICE_UNAVAILABLE',
      truncated,
    }
  }

  /** Resolve and consume snapshots only for the same canonical Coding session. */
  resolveForAgent(
    address: SessionAddressV1,
    snapshotIds: readonly string[],
  ): CodingContextAgentPayloadV1 {
    this.pruneExpired()
    const uniqueIds = [...new Set(snapshotIds)]
    if (uniqueIds.length === 0 || uniqueIds.length > CONTEXT_SOURCE_LIMIT) {
      throw new Error('CODING_CONTEXT_SNAPSHOT_REQUIRED')
    }
    const sources: CodingContextAgentPayloadV1['sources'][number][] = []
    for (const snapshotId of uniqueIds) {
      const snapshot = this.snapshots.get(snapshotId)
      if (!snapshot || !sameAddress(snapshot.address, address)) {
        throw new Error('CODING_CONTEXT_SNAPSHOT_SCOPE_MISMATCH')
      }
      sources.push(...snapshot.sources)
    }
    for (const snapshotId of uniqueIds) this.deleteSnapshot(snapshotId)
    return {
      schemaVersion: 1,
      snapshotIds: uniqueIds,
      sources,
      symbolService: 'UNAVAILABLE',
      diagnosticService: 'UNAVAILABLE',
    }
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) this.deleteSnapshot(snapshotId)
    }
  }

  private deleteSnapshot(snapshotId: string): void {
    const snapshot = this.snapshots.get(snapshotId)
    if (!snapshot) return
    this.snapshots.delete(snapshotId)
    this.storedBytes = Math.max(0, this.storedBytes - snapshot.byteLength)
    const timer = this.expiryTimers.get(snapshotId)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(snapshotId)
  }

  close(): void {
    for (const snapshotId of [...this.snapshots.keys()]) this.deleteSnapshot(snapshotId)
  }

  __testState(): { snapshotCount: number; storedBytes: number } {
    return { snapshotCount: this.snapshots.size, storedBytes: this.storedBytes }
  }
}

function sameAddress(left: SessionAddressV1, right: SessionAddressV1): boolean {
  return left.projectId === right.projectId && left.sessionKey === right.sessionKey
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

function positiveInteger(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
