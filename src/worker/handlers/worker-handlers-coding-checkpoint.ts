import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { errorMessage } from '@shared/error-message'
import { sessionFilePathsEqual } from '@shared/session-file-path'
import type { WorkerReply } from '../worker-handler-types.js'
import type { WorkerIncomingMessage } from '../worker-port-types.js'
import { isSessionBusy, st } from '../worker-runtime.js'

const CHECKPOINT_CUSTOM_TYPE = 'xiaogui.coding-checkpoint.v1'
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const SNAPSHOT_REF_PATTERN = /^xgscp_[a-f0-9]{64}$/

type CheckpointActionV1 = 'INSPECT' | 'CAPTURE' | 'RESTORE'

type SessionEntryLikeV1 = {
  readonly type: string
  readonly id: string
  readonly parentId: string | null
  readonly customType?: string
  readonly data?: unknown
  readonly [key: string]: unknown
}

type SessionManagerLikeV1 = {
  getLeafId(): string | null
  getEntries(): SessionEntryLikeV1[]
  getBranch(fromId?: string): SessionEntryLikeV1[]
  getEntry(id: string): SessionEntryLikeV1 | undefined
  appendCustomEntry(customType: string, data?: unknown): string
  branch(id: string): void
  resetLeaf(): void
  buildSessionContext(): { messages: unknown[] }
  isPersisted?(): boolean
  getSessionFile?(): string | undefined
}

type SnapshotMarkerV1 = {
  readonly schemaVersion: 1
  readonly kind: 'SNAPSHOT'
  readonly snapshotRef: string
  readonly snapshotDigest: string
  readonly targetLeafId: string | null
}

type RestoreHeadV1 = {
  readonly schemaVersion: 1
  readonly kind: 'RESTORE_HEAD'
  readonly snapshotRef: string
  readonly snapshotDigest: string
}

/**
 * Private Worker RPC for Coding checkpoints. It never returns a Session file,
 * leaf id, prompt body or message text to Main.
 */
export async function handleCodingSessionCheckpoint(
  msg: WorkerIncomingMessage,
  reply: WorkerReply,
): Promise<void> {
  try {
    const action = checkpointAction(msg.action)
    const session = st.session
    if (!session) throw new Error('PI_SESSION_CHECKPOINT_SESSION_UNAVAILABLE')
    if (isSessionBusy()) throw new Error('PI_SESSION_CHECKPOINT_SESSION_BUSY')
    if (
      typeof msg.sessionFile !== 'string'
      || !sessionFilePathsEqual(msg.sessionFile, session.sessionFile)
    ) throw new Error('PI_SESSION_CHECKPOINT_SESSION_FILE_MISMATCH')
    const expectedSessionId = safeSessionId(msg.expectedSessionId)
    if (!st.currentSessionId || st.currentSessionId !== expectedSessionId) {
      throw new Error('PI_SESSION_CHECKPOINT_SESSION_ID_MISMATCH')
    }
    const sm = session.sessionManager as unknown as SessionManagerLikeV1

    if (action === 'INSPECT') {
      reply({
        type: 'codingSessionCheckpoint-done',
        action,
        sessionId: expectedSessionId,
        snapshotDigest: sessionDigest(sm, expectedSessionId),
      })
      return
    }

    const snapshotRef = safeSnapshotRef(msg.snapshotRef)
    if (action === 'CAPTURE') {
      if (findSnapshotMarker(sm, snapshotRef)) {
        throw new Error('PI_SESSION_CHECKPOINT_REF_CONFLICT')
      }
      const targetLeafId = sm.getLeafId()
      const snapshotDigest = sessionDigest(sm, expectedSessionId, targetLeafId)
      const markerId = sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, {
        schemaVersion: 1,
        kind: 'SNAPSHOT',
        snapshotRef,
        snapshotDigest,
        targetLeafId,
      } satisfies SnapshotMarkerV1)
      try {
        assertMarkerPersisted(sm, msg.sessionFile, markerId, snapshotRef, 'SNAPSHOT')
      } finally {
        // The marker must remain persisted but must not become the live context tip.
        moveLiveLeafOrThrow(sm, targetLeafId)
      }
      reply({
        type: 'codingSessionCheckpoint-done',
        action,
        sessionId: expectedSessionId,
        snapshotRef,
        snapshotDigest,
      })
      return
    }

    const expectedDigest = safeDigest(msg.expectedDigest)
    const marker = findSnapshotMarker(sm, snapshotRef)
    if (!marker || marker.snapshotDigest !== expectedDigest) {
      throw new Error('PI_SESSION_CHECKPOINT_NOT_FOUND')
    }
    if (marker.targetLeafId !== null && !sm.getEntry(marker.targetLeafId)) {
      throw new Error('PI_SESSION_CHECKPOINT_TARGET_MISSING')
    }
    if (sessionDigest(sm, expectedSessionId, marker.targetLeafId) !== expectedDigest) {
      throw new Error('PI_SESSION_CHECKPOINT_TARGET_DIGEST_MISMATCH')
    }
    moveLiveLeafOrThrow(sm, marker.targetLeafId)
    // SessionManager leaf pointers are in memory. Appending a no-context restore
    // head makes the restored branch the last persisted branch after restart.
    const restoreHeadId = sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, {
      schemaVersion: 1,
      kind: 'RESTORE_HEAD',
      snapshotRef,
      snapshotDigest: expectedDigest,
    } satisfies RestoreHeadV1)
    assertMarkerPersisted(sm, msg.sessionFile, restoreHeadId, snapshotRef, 'RESTORE_HEAD')
    replaceAgentMessages(sm)
    if (sessionDigest(sm, expectedSessionId) !== expectedDigest) {
      throw new Error('PI_SESSION_CHECKPOINT_RESTORE_UNPROVEN')
    }
    reply({
      type: 'codingSessionCheckpoint-done',
      action,
      sessionId: expectedSessionId,
      restoredSnapshotDigest: expectedDigest,
    })
  } catch (error) {
    reply({
      type: 'error',
      error: `codingSessionCheckpoint failed: ${errorMessage(error)}`,
    })
  }
}

function checkpointAction(value: unknown): CheckpointActionV1 {
  if (value === 'INSPECT' || value === 'CAPTURE' || value === 'RESTORE') return value
  throw new Error('PI_SESSION_CHECKPOINT_ACTION_INVALID')
}

function safeSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)) {
    throw new Error('PI_SESSION_CHECKPOINT_SESSION_ID_INVALID')
  }
  return value
}

function safeSnapshotRef(value: unknown): string {
  if (typeof value !== 'string' || !SNAPSHOT_REF_PATTERN.test(value)) {
    throw new Error('PI_SESSION_CHECKPOINT_REF_INVALID')
  }
  return value
}

function safeDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error('PI_SESSION_CHECKPOINT_DIGEST_INVALID')
  }
  return value
}

function findSnapshotMarker(
  sm: SessionManagerLikeV1,
  snapshotRef: string,
): SnapshotMarkerV1 | null {
  for (const entry of sm.getEntries()) {
    if (entry.type !== 'custom' || entry.customType !== CHECKPOINT_CUSTOM_TYPE) continue
    const data = entry.data
    if (!data || typeof data !== 'object') continue
    const marker = data as Partial<SnapshotMarkerV1>
    if (
      marker.schemaVersion === 1
      && marker.kind === 'SNAPSHOT'
      && marker.snapshotRef === snapshotRef
      && typeof marker.snapshotDigest === 'string'
      && DIGEST_PATTERN.test(marker.snapshotDigest)
      && (marker.targetLeafId === null || typeof marker.targetLeafId === 'string')
    ) return marker as SnapshotMarkerV1
  }
  return null
}

function sessionDigest(
  sm: SessionManagerLikeV1,
  sessionId: string,
  leafId: string | null = sm.getLeafId(),
): string {
  const entries = leafId === null ? [] : sm.getBranch(leafId)
  const contextEntries = entries.filter((entry) => !(
    entry.type === 'custom' && entry.customType === CHECKPOINT_CUSTOM_TYPE
  ))
  return `sha256:${createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    sessionId,
    entries: contextEntries,
  })).digest('hex')}`
}

function moveLiveLeafOrThrow(sm: SessionManagerLikeV1, leafId: string | null): void {
  if (leafId === null) sm.resetLeaf()
  else sm.branch(leafId)
  if (sm.getLeafId() !== leafId) throw new Error('PI_SESSION_CHECKPOINT_LEAF_UNPROVEN')
  replaceAgentMessages(sm)
}

function replaceAgentMessages(sm: SessionManagerLikeV1): void {
  const context = sm.buildSessionContext()
  if (!Array.isArray(context?.messages) || !st.session?.agent?.state) {
    throw new Error('PI_SESSION_CHECKPOINT_CONTEXT_UNAVAILABLE')
  }
  st.session.agent.state.messages = context.messages as typeof st.session.agent.state.messages
}

function assertMarkerPersisted(
  sm: SessionManagerLikeV1,
  sessionFile: string,
  markerId: string,
  snapshotRef: string,
  kind: SnapshotMarkerV1['kind'] | RestoreHeadV1['kind'],
): void {
  // Production SessionManager exposes these methods. Structural unit fixtures
  // omit them; the real-SDK test covers this persistence proof.
  if (typeof sm.isPersisted !== 'function' || typeof sm.getSessionFile !== 'function') return
  if (!sm.isPersisted()) throw new Error('PI_SESSION_CHECKPOINT_MARKER_NOT_PERSISTED')
  const managerFile = sm.getSessionFile()
  if (!managerFile || !sessionFilePathsEqual(managerFile, sessionFile)) {
    throw new Error('PI_SESSION_CHECKPOINT_MARKER_NOT_PERSISTED')
  }
  try {
    const lines = readFileSync(managerFile, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      const entry = JSON.parse(line) as SessionEntryLikeV1
      if (entry.id !== markerId || entry.type !== 'custom' || entry.customType !== CHECKPOINT_CUSTOM_TYPE) {
        continue
      }
      const data = entry.data as Record<string, unknown> | undefined
      if (data?.schemaVersion === 1 && data.kind === kind && data.snapshotRef === snapshotRef) return
    }
  } catch {
    // The caller receives one stable fail-closed code; no file data enters logs.
  }
  throw new Error('PI_SESSION_CHECKPOINT_MARKER_NOT_PERSISTED')
}
