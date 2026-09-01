import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'

import type {
  AttemptCheckpointWorkspacePort,
  AttemptCheckpointabilityPort,
  CodingCheckpointCaptureResultV1,
  CodingCheckpointPreviewResultV1,
  CodingCheckpointRestoreResultV1,
  PiSessionCheckpointPort,
} from './checkpoint-module'
import { CodingCheckpointModuleV1 } from './checkpoint-module'
import type { CodingCheckpointScopePortV1 } from './checkpoint-ipc'
import { registerCodingCheckpointHandlersV1 } from './checkpoint-ipc'
import type {
  CheckpointAttemptSessionBindingV1,
  CheckpointSessionAddressRecordV1,
} from './checkpoint-session-binding-registry'
import { CheckpointSessionBindingRegistryV1 } from './checkpoint-session-binding-registry'
import type { CodingCheckpointPersistedStateV1 } from './checkpoint-module'
import type { PiSessionCheckpointWorkerGatewayV1 } from './pi-session-checkpoint-port'
import { PiSessionCheckpointPortV1 } from './pi-session-checkpoint-port'
import type { AttemptCheckpointOutcomeAuthorityV1 } from './attempt-checkpointability-port'
import { SqliteAttemptCheckpointabilityPortV1 } from './attempt-checkpointability-port'
import { SqliteAttemptCheckpointWorkspaceAuthorityV1 } from './attempt-checkpoint-workspace-authority'
import { GitAttemptCheckpointWorkspaceAdapterV1 } from './attempt-checkpoint-workspace-port'
import { CodingCheckpointStateStoreV1 } from './checkpoint-state-store'

type MaybePromise<T> = T | Promise<T>

interface ClosablePortV1 {
  close(): MaybePromise<void>
}

export interface CodingCheckpointSessionRegistryPortV1 extends ClosablePortV1 {
  recordAddress(input: CheckpointSessionAddressRecordV1): void
  readAddressBinding(address: SessionAddressV1): CheckpointSessionAddressRecordV1 | null
  bindAttempt(
    attemptId: string,
    address: SessionAddressV1,
  ): CheckpointAttemptSessionBindingV1
}

export interface CodingCheckpointPiSessionPortV1
  extends PiSessionCheckpointPort, ClosablePortV1 {
  bindAttempt(input: {
    readonly attemptId: string
    readonly sessionId: string
    readonly sessionFile: string
  }): void
}

export interface CodingCheckpointStateStorePortV1 extends ClosablePortV1 {
  load(): CodingCheckpointPersistedStateV1 | undefined
  save(state: CodingCheckpointPersistedStateV1): MaybePromise<void>
}

export interface CodingCheckpointProductionPortsV1 {
  readonly registry: CodingCheckpointSessionRegistryPortV1
  readonly sessions: CodingCheckpointPiSessionPortV1
  readonly attempts: AttemptCheckpointabilityPort & Partial<ClosablePortV1>
  readonly workspace: AttemptCheckpointWorkspacePort & Partial<ClosablePortV1>
  readonly stateStore: CodingCheckpointStateStorePortV1
  /** Authoritative CODING session and Attempt ownership check. */
  readonly scope: CodingCheckpointScopePortV1 & Partial<ClosablePortV1>
}

export type CodingCheckpointProductionStatusV1 =
  | 'RECOVERING'
  | 'READY'
  | 'UNAVAILABLE'
  | 'CLOSED'

export interface CodingCheckpointProductionCheckpointPortV1 {
  list(attemptId: string): readonly import('@shared/xiaogui-coding-extension-pack').CodingCheckpointV1[]
  capture(input: {
    readonly attemptId: string
    readonly checkpointId: string
  }): Promise<CodingCheckpointCaptureResultV1>
  prepareRestore(input: {
    readonly attemptId: string
    readonly checkpointId: string
  }): Promise<CodingCheckpointPreviewResultV1>
  restore(input: {
    readonly attemptId: string
    readonly checkpointId: string
    readonly previewId: string
    readonly previewDigest: string
  }): Promise<CodingCheckpointRestoreResultV1>
}

export interface CodingCheckpointProductionHandlerRegistrationV1 {
  readonly checkpoint: CodingCheckpointProductionCheckpointPortV1
  readonly scope: CodingCheckpointScopePortV1
}

export interface CodingCheckpointProductionCompositionOptionsV1 {
  readonly ports: CodingCheckpointProductionPortsV1
  /** Defaults to the real checkpoint IPC registration in the production factory. */
  readonly registerHandlers: (
    input: CodingCheckpointProductionHandlerRegistrationV1,
  ) => void
}

export interface CodingCheckpointProductionPathsV1 {
  /** Authoritative TaskHub database. */
  readonly hubDbPath: string
  /** Authoritative private Attempt-workspace registry; deliberately not hubDbPath. */
  readonly workspaceRegistryDbPath: string
  readonly privateCheckpointDbPath: string
  readonly managedAttemptWorktreeRoot: string
  readonly workspaceSnapshotRoot: string
}

export interface DefaultCodingCheckpointProductionCompositionOptionsV1 {
  readonly userDataDir: string
  readonly worker: PiSessionCheckpointWorkerGatewayV1
  readonly authority: AttemptCheckpointOutcomeAuthorityV1
}

export interface CodingCheckpointProductionCompositionV1 {
  status(): CodingCheckpointProductionStatusV1
  /** Starts persisted restore-saga recovery. Mutations remain disabled until it resolves. */
  initialize(): Promise<void>
  /** Idempotently registers the fail-closed IPC projection. */
  register(): void
  /** Trusted Worker callback used before a CODING plan draft is published. */
  recordTrustedSessionAddress(input: CheckpointSessionAddressRecordV1): void
  /** Main-only lookup; callers must not return the private record through IPC. */
  readTrustedSessionAddress(address: SessionAddressV1): CheckpointSessionAddressRecordV1
  close(): Promise<void>
}

/**
 * Owns the production checkpoint deep-module lifecycle without owning TaskHub.
 *
 * The injected scope remains the authority for CODING/Attempt ownership. Only
 * after that check succeeds is its trusted opaque address allowed to bind the
 * private Pi session file. The Renderer-facing checkpoint port stays disabled
 * until restart recovery is complete and is disabled again before close starts.
 */
export function createCodingCheckpointProductionCompositionV1(
  options: CodingCheckpointProductionCompositionOptionsV1,
): CodingCheckpointProductionCompositionV1 {
  const { ports } = options
  const persistedState = ports.stateStore.load()
  const checkpointModule = new CodingCheckpointModuleV1({
    attempts: ports.attempts,
    sessions: ports.sessions,
    workspace: ports.workspace,
    persistedState,
    persistState: (state) => ports.stateStore.save(state),
  })

  let lifecycleStatus: CodingCheckpointProductionStatusV1 = 'RECOVERING'
  let registered = false
  let initializePromise: Promise<void> | undefined
  let closePromise: Promise<void> | undefined

  const guardedCheckpoint: CodingCheckpointProductionCheckpointPortV1 = {
    list(attemptId) {
      requireReady()
      return checkpointModule.list(attemptId)
    },
    async capture(input) {
      requireReady()
      return checkpointModule.capture(input)
    },
    async prepareRestore(input) {
      requireReady()
      return checkpointModule.prepareRestore(input)
    },
    async restore(input) {
      requireReady()
      return checkpointModule.restore(input)
    },
  }

  const guardedScope: CodingCheckpointScopePortV1 = {
    async isCodingSession(address) {
      if (lifecycleStatus === 'CLOSED') return false
      try {
        return await ports.scope.isCodingSession(address)
      } catch {
        return false
      }
    },
    async hasAttempt(address, attemptId) {
      if (lifecycleStatus === 'CLOSED') return false
      try {
        if (!(await ports.scope.hasAttempt(address, attemptId))) return false
        const privateBinding = ports.registry.bindAttempt(attemptId, address as SessionAddressV1)
        if (
          privateBinding.attemptId !== attemptId
          || privateBinding.address.projectId !== address.projectId
          || privateBinding.address.sessionKey !== address.sessionKey
        ) return false
        ports.sessions.bindAttempt({
          attemptId,
          sessionId: privateBinding.sourceSessionId,
          sessionFile: privateBinding.sessionFile,
        })
        return true
      } catch {
        return false
      }
    },
  }

  function requireReady(): void {
    if (lifecycleStatus !== 'READY') throw new Error('CHECKPOINT_RUNTIME_UNAVAILABLE')
  }

  return {
    status: () => lifecycleStatus,

    initialize() {
      if (initializePromise) return initializePromise
      if (lifecycleStatus === 'CLOSED') {
        return Promise.reject(new Error('CHECKPOINT_RUNTIME_CLOSED'))
      }
      initializePromise = (async () => {
        try {
          const recovered = await checkpointModule.recover()
          if (recovered.some((result) => result.outcome === 'OUTCOME_UNKNOWN')) {
            throw new Error('CHECKPOINT_RECOVERY_OUTCOME_UNKNOWN')
          }
          if ((lifecycleStatus as CodingCheckpointProductionStatusV1) !== 'CLOSED') lifecycleStatus = 'READY'
        } catch {
          if ((lifecycleStatus as CodingCheckpointProductionStatusV1) !== 'CLOSED') lifecycleStatus = 'UNAVAILABLE'
          throw new Error('CHECKPOINT_RUNTIME_RECOVERY_FAILED')
        }
      })()
      return initializePromise
    },

    register() {
      if (registered) return
      if (lifecycleStatus === 'CLOSED') throw new Error('CHECKPOINT_RUNTIME_CLOSED')
      registered = true
      options.registerHandlers({ checkpoint: guardedCheckpoint, scope: guardedScope })
    },

    recordTrustedSessionAddress(input) {
      if (lifecycleStatus === 'CLOSED') throw new Error('CHECKPOINT_RUNTIME_CLOSED')
      ports.registry.recordAddress(input)
    },

    readTrustedSessionAddress(address) {
      if (lifecycleStatus === 'CLOSED') throw new Error('CHECKPOINT_RUNTIME_CLOSED')
      const record = ports.registry.readAddressBinding(address)
      if (!record) throw new Error('CHECKPOINT_SESSION_REGISTRY_ADDRESS_NOT_FOUND')
      return record
    },

    close() {
      if (closePromise) return closePromise
      lifecycleStatus = 'CLOSED'
      closePromise = (async () => {
        try {
          await initializePromise?.catch(() => undefined)
        } finally {
          await closeOwnedPorts([
            ports.workspace,
            ports.attempts,
            ports.sessions,
            ports.registry,
            ports.scope,
            ports.stateStore,
          ])
        }
      })()
      return closePromise
    },
  }
}

/**
 * Builds the real Main-process Adapter graph from the current TaskHub disk
 * layout. The two TaskHub databases are intentionally explicit: treating the
 * empty compatibility tables in hubDbPath as workspace authority would make
 * every binding unprovable (or tempt a caller to copy private worktree data).
 */
export function createDefaultCodingCheckpointProductionCompositionV1(
  options: DefaultCodingCheckpointProductionCompositionOptionsV1,
): CodingCheckpointProductionCompositionV1 {
  const paths = codingCheckpointProductionPathsV1(options.userDataDir)
  mkdirSync(resolve(paths.privateCheckpointDbPath, '..'), { recursive: true })
  mkdirSync(paths.workspaceSnapshotRoot, { recursive: true })

  let registry: CheckpointSessionBindingRegistryV1 | undefined
  let sessions: PiSessionCheckpointPortV1 | undefined
  let attempts: SqliteAttemptCheckpointabilityPortV1 | undefined
  let workspaceAuthority: SqliteAttemptCheckpointWorkspaceAuthorityV1 | undefined
  let scope: SqliteCodingCheckpointScopePortV1 | undefined
  let stateStore: CodingCheckpointStateStoreV1 | undefined

  try {
    registry = new CheckpointSessionBindingRegistryV1({
      dbPath: paths.privateCheckpointDbPath,
    })
    sessions = new PiSessionCheckpointPortV1({
      // The checkpointability Adapter reads this binding as part of its
      // authoritative cross-database join, so it belongs in the hub DB.
      dbPath: paths.hubDbPath,
      worker: options.worker,
    })
    attempts = new SqliteAttemptCheckpointabilityPortV1({
      dbPath: paths.hubDbPath,
      workspaceDbPath: paths.workspaceRegistryDbPath,
      authority: options.authority,
    })
    workspaceAuthority = new SqliteAttemptCheckpointWorkspaceAuthorityV1({
      workspaceDbPath: paths.workspaceRegistryDbPath,
      attempts,
    })
    const workspaceAdapter = new GitAttemptCheckpointWorkspaceAdapterV1({
      authority: workspaceAuthority,
      managedRoot: paths.managedAttemptWorktreeRoot,
      snapshotRoot: paths.workspaceSnapshotRoot,
    })
    const workspace = Object.assign(workspaceAdapter, {
      close: () => workspaceAuthority?.close(),
    })
    stateStore = new CodingCheckpointStateStoreV1({
      dbPath: paths.privateCheckpointDbPath,
    })
    scope = new SqliteCodingCheckpointScopePortV1({
      hubDbPath: paths.hubDbPath,
      privateCheckpointDbPath: paths.privateCheckpointDbPath,
    })

    return createCodingCheckpointProductionCompositionV1({
      ports: { registry, sessions, attempts, workspace, stateStore, scope },
      registerHandlers: registerCodingCheckpointHandlersV1,
    })
  } catch (error) {
    closeImmediately([workspaceAuthority, attempts, sessions, registry, scope, stateStore])
    throw redactedCompositionError(error)
  }
}

export function codingCheckpointProductionPathsV1(userDataDir: string): CodingCheckpointProductionPathsV1 {
  if (
    typeof userDataDir !== 'string'
    || userDataDir !== userDataDir.trim()
    || !isAbsolute(userDataDir)
  ) throw new Error('CHECKPOINT_USER_DATA_DIR_INVALID')
  const userData = resolve(userDataDir)
  const xiaogui = join(userData, 'xiaogui')
  const checkpointDir = join(xiaogui, 'coding-checkpoints')
  return Object.freeze({
    hubDbPath: join(userData, 'xiaogui-task-hub-m2a.sqlite'),
    workspaceRegistryDbPath: join(xiaogui, 'task-hub', 'attempt-workspaces.sqlite'),
    privateCheckpointDbPath: join(checkpointDir, 'checkpoint-private-v1.sqlite'),
    managedAttemptWorktreeRoot: join(xiaogui, 'attempt-worktrees'),
    workspaceSnapshotRoot: join(checkpointDir, 'workspace-snapshots'),
  })
}

const PROJECT_ID_PATTERN = /^xgp1_[a-f0-9]{64}$/i
const SESSION_KEY_PATTERN = /^xgs1_[a-f0-9]{64}$/i
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

/** Synchronous, read-only scope gate required by the existing IPC registry. */
class SqliteCodingCheckpointScopePortV1 implements CodingCheckpointScopePortV1, ClosablePortV1 {
  private readonly hub: DatabaseSync
  private readonly privateCheckpoint: DatabaseSync
  private closed = false

  constructor(options: {
    readonly hubDbPath: string
    readonly privateCheckpointDbPath: string
  }) {
    this.hub = new DatabaseSync(options.hubDbPath, { readOnly: true })
    this.privateCheckpoint = new DatabaseSync(options.privateCheckpointDbPath, { readOnly: true })
    this.hub.exec('pragma busy_timeout = 5000')
    this.privateCheckpoint.exec('pragma busy_timeout = 5000')
  }

  isCodingSession(address: SessionAddressV1): boolean {
    if (this.closed || !safeAddress(address)) return false
    try {
      return Boolean(this.privateCheckpoint.prepare(`
        select 1 as present
        from xiaogui_coding_pi_session_address_v1
        where project_id = ? and session_key = ?
        limit 1
      `).get(address.projectId, address.sessionKey))
    } catch {
      return false
    }
  }

  hasAttempt(address: SessionAddressV1, attemptId: string): boolean {
    if (this.closed || !safeAddress(address) || !SAFE_ID_PATTERN.test(attemptId)) return false
    try {
      return Boolean(this.hub.prepare(`
        select 1 as present
        from attempts a
        join xiaogui_coding_attempt_plan_v1 p on p.attempt_id = a.attempt_id
        where a.attempt_id = ?
          and a.project_id = ? and a.session_key = ?
          and p.project_id = a.project_id and p.session_key = a.session_key
        limit 1
      `).get(attemptId, address.projectId, address.sessionKey))
    } catch {
      return false
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.privateCheckpoint.close()
    this.hub.close()
  }
}

function safeAddress(value: SessionAddressV1): boolean {
  return Boolean(
    value
    && PROJECT_ID_PATTERN.test(value.projectId)
    && SESSION_KEY_PATTERN.test(value.sessionKey),
  )
}

function closeImmediately(values: readonly (Partial<ClosablePortV1> | undefined)[]): void {
  const closed = new Set<object>()
  for (const value of values) {
    if (!value || typeof value.close !== 'function' || closed.has(value)) continue
    closed.add(value)
    try {
      void value.close()
    } catch {
      // Construction fails with one stable redacted error below.
    }
  }
}

function redactedCompositionError(_error: unknown): Error {
  return new Error('CHECKPOINT_PRODUCTION_COMPOSITION_UNAVAILABLE')
}

async function closeOwnedPorts(
  values: readonly (Partial<ClosablePortV1> | undefined)[],
): Promise<void> {
  const closed = new Set<object>()
  for (const value of values) {
    if (!value || typeof value.close !== 'function' || closed.has(value)) continue
    closed.add(value)
    try {
      await value.close()
    } catch {
      // Closing one private Adapter must not skip the remaining owned stores.
    }
  }
}
