import { OfficeSurfaceError } from './xiaogui-office-errors'

export type OfficeWorktreeStateV1 = 'DRAFT' | 'READY' | 'MERGED' | 'DISCARDED'
export type OfficeWorktreeActorV1 = 'USER' | 'SYSTEM'

export interface OfficeWorktreeV1 {
  readonly version: 1
  readonly worktreeId: string
  readonly documentId: string
  readonly state: OfficeWorktreeStateV1
  readonly baseTrunkSha256: string
  readonly headSha256: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly mergedAt?: string
  readonly discardedAt?: string
}

export interface OfficeWorktreeMergeResultV1 {
  readonly worktree: OfficeWorktreeV1
  readonly trunkSha256: string
}

export function createOfficeWorktreeV1(input: {
  worktreeId: string
  documentId: string
  trunkSha256: string
  now?: string
}): OfficeWorktreeV1 {
  assertIdentifier(input.worktreeId, 'worktreeId')
  assertIdentifier(input.documentId, 'documentId')
  assertDigest(input.trunkSha256)
  const now = input.now ?? new Date().toISOString()
  return Object.freeze({
    version: 1,
    worktreeId: input.worktreeId,
    documentId: input.documentId,
    state: 'DRAFT',
    baseTrunkSha256: input.trunkSha256,
    headSha256: input.trunkSha256,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  })
}

export function saveOfficeWorktreeHeadV1(
  worktree: OfficeWorktreeV1,
  input: { expectedHeadSha256: string; nextHeadSha256: string; now?: string },
): OfficeWorktreeV1 {
  assertState(worktree, 'DRAFT')
  assertDigest(input.expectedHeadSha256)
  assertDigest(input.nextHeadSha256)
  if (worktree.headSha256 !== input.expectedHeadSha256) {
    throw new OfficeSurfaceError('OFFICE_WORKTREE_CONFLICT', '工作副本已被更新，请重新载入后再保存。')
  }
  return freezeUpdate(worktree, {
    headSha256: input.nextHeadSha256,
    revision: worktree.revision + 1,
    updatedAt: input.now ?? new Date().toISOString(),
  })
}

export function markOfficeWorktreeReadyV1(
  worktree: OfficeWorktreeV1,
  input: { expectedHeadSha256: string; now?: string },
): OfficeWorktreeV1 {
  assertState(worktree, 'DRAFT')
  if (worktree.headSha256 !== input.expectedHeadSha256) {
    throw new OfficeSurfaceError('OFFICE_WORKTREE_CONFLICT', '工作副本内容已变化，不能进入待合并状态。')
  }
  return freezeUpdate(worktree, {
    state: 'READY',
    revision: worktree.revision + 1,
    updatedAt: input.now ?? new Date().toISOString(),
  })
}

export function reopenOfficeWorktreeV1(worktree: OfficeWorktreeV1, now?: string): OfficeWorktreeV1 {
  assertState(worktree, 'READY')
  return freezeUpdate(worktree, {
    state: 'DRAFT',
    revision: worktree.revision + 1,
    updatedAt: now ?? new Date().toISOString(),
  })
}

export function mergeOfficeWorktreeV1(
  worktree: OfficeWorktreeV1,
  input: { actor: OfficeWorktreeActorV1; currentTrunkSha256: string; now?: string },
): OfficeWorktreeMergeResultV1 {
  assertUserAction(input.actor)
  assertState(worktree, 'READY')
  assertDigest(input.currentTrunkSha256)
  if (worktree.baseTrunkSha256 !== input.currentTrunkSha256) {
    throw new OfficeSurfaceError('OFFICE_WORKTREE_TRUNK_DIVERGED', '正式版本已经变化，必须重新对比后再合并。')
  }
  const now = input.now ?? new Date().toISOString()
  return {
    worktree: freezeUpdate(worktree, {
      state: 'MERGED',
      revision: worktree.revision + 1,
      updatedAt: now,
      mergedAt: now,
    }),
    trunkSha256: worktree.headSha256,
  }
}

export function discardOfficeWorktreeV1(
  worktree: OfficeWorktreeV1,
  input: { actor: OfficeWorktreeActorV1; now?: string },
): OfficeWorktreeV1 {
  assertUserAction(input.actor)
  if (worktree.state !== 'DRAFT' && worktree.state !== 'READY') {
    throw new OfficeSurfaceError('OFFICE_WORKTREE_INVALID_STATE', `当前状态 ${worktree.state} 不能丢弃。`)
  }
  const now = input.now ?? new Date().toISOString()
  return freezeUpdate(worktree, {
    state: 'DISCARDED',
    revision: worktree.revision + 1,
    updatedAt: now,
    discardedAt: now,
  })
}

export function hasOfficeTrunkDivergedV1(worktree: OfficeWorktreeV1, currentTrunkSha256: string): boolean {
  assertDigest(currentTrunkSha256)
  return worktree.baseTrunkSha256 !== currentTrunkSha256
}

function assertUserAction(actor: OfficeWorktreeActorV1): void {
  if (actor !== 'USER') {
    throw new OfficeSurfaceError('OFFICE_WORKTREE_USER_ACTION_REQUIRED', '只有用户可以合并或丢弃工作副本。')
  }
}

function assertState(worktree: OfficeWorktreeV1, expected: OfficeWorktreeStateV1): void {
  if (worktree.state !== expected) {
    throw new OfficeSurfaceError('OFFICE_WORKTREE_INVALID_STATE', `当前状态 ${worktree.state} 不能执行此操作。`)
  }
}

function assertDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new OfficeSurfaceError('OFFICE_SNAPSHOT_INVALID', '快照摘要格式无效。')
  }
}

function assertIdentifier(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new OfficeSurfaceError('OFFICE_SNAPSHOT_INVALID', `${name} 格式无效。`)
  }
}

function freezeUpdate(worktree: OfficeWorktreeV1, patch: Partial<OfficeWorktreeV1>): OfficeWorktreeV1 {
  return Object.freeze({ ...worktree, ...patch })
}
