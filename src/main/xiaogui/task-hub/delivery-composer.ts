import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

import type { FlowId } from '@shared/xiaogui-collaboration-hub'
import {
  deliveryChangeSetDigestV1,
  deliveryChangeSetDigestV2,
  type DeliveryBatchId,
  type DeliveryChangeSetId,
  type DeliveryChangeSetV1,
  type DeliveryChangeSetV2,
  type DeliveryFileChangeSummaryV2,
  type DeliveryFileChangeSummaryV1,
  type DeliverySelectionDraftId,
  type DeliveryTaskChangeSetRefV1,
  type DeliveryTargetV1,
} from '@shared/xiaogui-delivery'
import {
  taskChangeSetDigestV1,
  type ArtifactId,
  type IsoDateTime,
  type Sha256Digest,
  type TaskChangeSetId,
  type TaskChangeSetV1,
} from '@shared/xiaogui-task-verification'

import type {
  TaskPatchArtifactV1,
  TaskPatchArtifactV2,
  TaskPatchFileSnapshotV1,
  TaskPatchFileSnapshotV2,
} from './attempt-workspace'

export interface DeliveryPatchArtifactInputV1 {
  readonly artifactId: ArtifactId
  readonly digest: Sha256Digest
  readonly bytes: Uint8Array
}

export interface DeliveryComposerTaskInputV1 {
  readonly changeSet: TaskChangeSetV1
  readonly patchArtifact: DeliveryPatchArtifactInputV1
}

export interface DeliveryIntegrationFileV1 {
  readonly operation: 'MODIFY' | 'CREATE'
  readonly relativePath: string
  readonly baselineDigest: Sha256Digest | null
  readonly contentDigest: Sha256Digest
  readonly contentArtifactId: ArtifactId
  readonly content: Uint8Array
  readonly sourceTaskChangeSetId: TaskChangeSetId
}

export type DeliveryIntegrationFileV2 =
  | {
      readonly operation: 'MODIFY'
      readonly relativePath: string
      readonly baselineDigest: Sha256Digest
      readonly contentDigest: Sha256Digest
      readonly contentArtifactId: ArtifactId
      readonly content: Uint8Array
      readonly sourceTaskChangeSetId: TaskChangeSetId
      readonly rename?: TaskPatchFileSnapshotV2['rename']
    }
  | {
      readonly operation: 'CREATE'
      readonly relativePath: string
      readonly baselineDigest: null
      readonly contentDigest: Sha256Digest
      readonly contentArtifactId: ArtifactId
      readonly content: Uint8Array
      readonly sourceTaskChangeSetId: TaskChangeSetId
      readonly rename?: TaskPatchFileSnapshotV2['rename']
    }
  | {
      readonly operation: 'DELETE'
      readonly relativePath: string
      readonly baselineDigest: Sha256Digest
      readonly contentDigest: null
      readonly sourceTaskChangeSetId: TaskChangeSetId
      readonly rename?: TaskPatchFileSnapshotV2['rename']
    }

export interface DeliveryComposedFileArtifactV1 {
  readonly artifactId: ArtifactId
  readonly contentDigest: Sha256Digest
  readonly kind: 'DELIVERY_FILE_CONTENT'
  readonly mediaType: 'application/vnd.xiaogui.delivery-file-content'
  readonly content: Uint8Array
}

export interface DeliveryIntegrationResultV1 {
  readonly integrationTreeHash: Sha256Digest
  readonly privateIntegrationContext: {
    readonly worktreeRoot: string
    readonly trustedToolchainRoot: string
  }
}

export interface DeliveryIntegrationWorktreePortV1 {
  integrate(files: readonly DeliveryIntegrationFileV1[]): Promise<DeliveryIntegrationResultV1>
}

export interface DeliveryIntegrationWorktreePortV2 {
  integrateV2(files: readonly DeliveryIntegrationFileV2[]): Promise<DeliveryIntegrationResultV1>
}

export interface ComposeDeliveryInputV1 {
  readonly flowId: FlowId
  readonly deliveryBatchId: DeliveryBatchId
  readonly selectionDraftId: DeliverySelectionDraftId
  readonly deliveryChangeSetId: DeliveryChangeSetId
  readonly taskInputs: readonly DeliveryComposerTaskInputV1[]
  readonly dependencyOrder: readonly TaskChangeSetId[]
  readonly selectionDigest: Sha256Digest
  readonly target: DeliveryTargetV1
  readonly qaConfigVersion: string
  readonly createdAt: IsoDateTime
}

export interface DeliveryPatchArtifactInputV2 {
  readonly artifactId: ArtifactId
  readonly digest: Sha256Digest
  readonly bytes: Uint8Array
}

export interface DeliveryComposerTaskInputV2 {
  readonly changeSet: TaskChangeSetV1
  readonly patchArtifact: DeliveryPatchArtifactInputV2
}

export type ComposeDeliveryInputV2 = Omit<ComposeDeliveryInputV1, 'taskInputs'> & {
  readonly taskInputs: readonly DeliveryComposerTaskInputV2[]
}

export type DeliveryCompositionConflictCodeV1 =
  | 'NO_TASK_CHANGESETS'
  | 'TASK_FLOW_MISMATCH'
  | 'TASK_CHANGESET_DIGEST_DRIFT'
  | 'PATCH_ARTIFACT_BINDING_MISMATCH'
  | 'PATCH_ARTIFACT_DIGEST_DRIFT'
  | 'PATCH_ARTIFACT_INVALID'
  | 'PATCH_FILE_DIGEST_DRIFT'
  | 'DELETE_FORBIDDEN'
  | 'DEPENDENCY_CLOSURE_INCOMPLETE'
  | 'DEPENDENCY_ORDER_INVALID'
  | 'SAME_FILE_NON_DETERMINISTIC'

export type ComposeDeliveryResultV1 =
  | {
      readonly ok: true
      readonly changeSet: DeliveryChangeSetV1 & {
        readonly taskChangeSets: readonly DeliveryTaskChangeSetRefV1[]
        readonly fileChanges: readonly DeliveryFileChangeSummaryV1[]
      }
      readonly files: readonly DeliveryIntegrationFileV1[]
      readonly artifacts: readonly DeliveryComposedFileArtifactV1[]
      readonly privateIntegrationContext: DeliveryIntegrationResultV1['privateIntegrationContext']
    }
  | {
      readonly ok: false
      readonly reasonCode: DeliveryCompositionConflictCodeV1
      readonly conflicts: readonly { readonly relativePath?: string; readonly taskChangeSetIds: readonly TaskChangeSetId[] }[]
    }

export type ResolveTaskChangeSetFilesResultV1 =
  | {
      readonly ok: true
      readonly files: readonly DeliveryIntegrationFileV1[]
      readonly refs: readonly DeliveryTaskChangeSetRefV1[]
    }
  | Extract<ComposeDeliveryResultV1, { ok: false }>

export type DeliveryCompositionConflictCodeV2 =
  | 'NO_TASK_CHANGESETS'
  | 'TASK_FLOW_MISMATCH'
  | 'TASK_CHANGESET_DIGEST_DRIFT'
  | 'PATCH_ARTIFACT_BINDING_MISMATCH'
  | 'PATCH_ARTIFACT_DIGEST_DRIFT'
  | 'PATCH_ARTIFACT_INVALID'
  | 'PATCH_FILE_DIGEST_DRIFT'
  | 'RENAME_INVALID'
  | 'DEPENDENCY_CLOSURE_INCOMPLETE'
  | 'DEPENDENCY_ORDER_INVALID'
  | 'SAME_FILE_NON_DETERMINISTIC'

export type ComposeDeliveryResultV2 =
  | {
      readonly ok: true
      readonly changeSet: DeliveryChangeSetV2
      readonly files: readonly DeliveryIntegrationFileV2[]
      readonly artifacts: readonly DeliveryComposedFileArtifactV1[]
      readonly privateIntegrationContext: DeliveryIntegrationResultV1['privateIntegrationContext']
    }
  | {
      readonly ok: false
      readonly reasonCode: DeliveryCompositionConflictCodeV2
      readonly conflicts: readonly { readonly relativePath?: string; readonly taskChangeSetIds: readonly TaskChangeSetId[] }[]
    }

export type ResolveTaskChangeSetFilesResultV2 =
  | {
      readonly ok: true
      readonly files: readonly DeliveryIntegrationFileV2[]
      readonly refs: readonly DeliveryTaskChangeSetRefV1[]
    }
  | Extract<ComposeDeliveryResultV2, { ok: false }>

/**
 * Single parser/validator seam for the repository's TASK_PATCH_V1 format.
 * Delivery keeps conservative same-file rejection; dependency-derived
 * baselines may opt into ordered precondition application.
 */
export function resolveTaskChangeSetFilesV1(input: {
  readonly flowId: FlowId
  readonly taskInputs: readonly DeliveryComposerTaskInputV1[]
  readonly dependencyOrder: readonly TaskChangeSetId[]
  readonly allowOrderedSameFileChanges?: boolean
}): ResolveTaskChangeSetFilesResultV1 {
  if (input.taskInputs.length === 0) return conflict('NO_TASK_CHANGESETS', [])
  const selectedIds = input.taskInputs.map((task) => task.changeSet.taskChangeSetId)
  const selectedIdSet = new Set(selectedIds)
  if (selectedIdSet.size !== selectedIds.length) return conflict('DEPENDENCY_ORDER_INVALID', [])

  const dependencyCheck = validateDependencyClosure(input.taskInputs, input.dependencyOrder)
  if (!dependencyCheck.ok) return dependencyCheck

  const orderedInputs = new Map(input.taskInputs.map((task) => [task.changeSet.taskChangeSetId, task]))
  const files: DeliveryIntegrationFileV1[] = []
  const refs: DeliveryTaskChangeSetRefV1[] = []
  for (const taskChangeSetId of input.dependencyOrder) {
    const task = orderedInputs.get(taskChangeSetId)
    if (!task) continue
    const changeSet = task.changeSet
    if (changeSet.flowId !== input.flowId) return conflict('TASK_FLOW_MISMATCH', [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    if (taskChangeSetDigestV1(changeSet) !== changeSet.digest) {
      return conflict('TASK_CHANGESET_DIGEST_DRIFT', [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    }
    if (changeSet.patchArtifactId !== task.patchArtifact.artifactId) {
      return conflict('PATCH_ARTIFACT_BINDING_MISMATCH', [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    }
    if (digestBytes(task.patchArtifact.bytes) !== task.patchArtifact.digest) {
      return conflict('PATCH_ARTIFACT_DIGEST_DRIFT', [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    }

    const patch = parsePatchArtifact(task.patchArtifact.bytes)
    if (!patch.ok) return conflict(patch.reasonCode, [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])

    refs.push({
      taskChangeSetId: changeSet.taskChangeSetId,
      taskRunId: changeSet.taskRunId,
      digest: changeSet.digest,
      patchArtifactId: changeSet.patchArtifactId,
      dependsOn: changeSet.ancestorTaskChangeSetIds,
    })
    for (const file of patch.files) {
      const normalized = normalizeRelativePath(file.relativePath)
      if (file.operation !== 'MODIFY' && file.operation !== 'CREATE') {
        return conflict('DELETE_FORBIDDEN', [{ relativePath: normalized, taskChangeSetIds: [changeSet.taskChangeSetId] }])
      }
      const content = Buffer.from(file.contentBase64, 'base64')
      if (digestBytes(content) !== file.contentDigest) {
        return conflict('PATCH_FILE_DIGEST_DRIFT', [{ relativePath: normalized, taskChangeSetIds: [changeSet.taskChangeSetId] }])
      }
      files.push({
        operation: file.operation,
        relativePath: normalized,
        baselineDigest: file.baselineDigest as Sha256Digest | null,
        contentDigest: file.contentDigest as Sha256Digest,
        contentArtifactId: deliveryFileContentArtifactId({
          relativePath: normalized,
          contentDigest: file.contentDigest as Sha256Digest,
          sourceTaskChangeSetId: changeSet.taskChangeSetId,
        }),
        content,
        sourceTaskChangeSetId: changeSet.taskChangeSetId,
      })
    }
  }

  if (!input.allowOrderedSameFileChanges) {
    const sameFileConflict = findSameFileConflict(files)
    if (sameFileConflict) return conflict('SAME_FILE_NON_DETERMINISTIC', [sameFileConflict])
  }
  return { ok: true, files, refs }
}

export class DeliveryComposerV1 {
  constructor(private readonly integrationWorktree: DeliveryIntegrationWorktreePortV1) {}

  async compose(input: ComposeDeliveryInputV1): Promise<ComposeDeliveryResultV1> {
    const resolved = resolveTaskChangeSetFilesV1(input)
    if (!resolved.ok) return resolved
    const { files, refs } = resolved

    const integration = await this.integrationWorktree.integrate(files)
    const artifacts = files.map((file): DeliveryComposedFileArtifactV1 => ({
      artifactId: file.contentArtifactId,
      contentDigest: file.contentDigest,
      kind: 'DELIVERY_FILE_CONTENT',
      mediaType: 'application/vnd.xiaogui.delivery-file-content',
      content: file.content,
    }))
    const fileChanges = files.map((file): DeliveryFileChangeSummaryV1 => ({
      operation: file.operation,
      relativePath: file.relativePath,
      baselineDigest: file.baselineDigest,
      contentDigest: file.contentDigest,
      contentArtifactId: file.contentArtifactId,
      sourceTaskChangeSetIds: [file.sourceTaskChangeSetId],
    }))
    const changeSetWithoutDigest = {
      kind: 'DELIVERY_CHANGESET' as const,
      version: 1 as const,
      deliveryChangeSetId: input.deliveryChangeSetId,
      batchId: input.deliveryBatchId,
      selectionDraftId: input.selectionDraftId,
      flowId: input.flowId,
      selectionDigest: input.selectionDigest,
      taskChangeSetIds: refs.map((ref) => ref.taskChangeSetId),
      taskChangeSets: refs,
      dependencyOrder: input.dependencyOrder,
      fileChanges,
      target: input.target,
      integrationTreeHash: integration.integrationTreeHash,
      evidenceArtifactIds: [],
      qaConfigVersion: input.qaConfigVersion,
      createdAt: input.createdAt,
    }
    return {
      ok: true,
      changeSet: {
        ...changeSetWithoutDigest,
        digest: deliveryChangeSetDigestV1(changeSetWithoutDigest),
      },
      files,
      artifacts,
      privateIntegrationContext: integration.privateIntegrationContext,
    }
  }
}

/**
 * DELETE/CREATE-only extension seam. The V1 parser and composer deliberately
 * stay unchanged so old artifacts retain their CREATE/MODIFY semantics.
 */
export function resolveTaskChangeSetFilesV2(input: {
  readonly flowId: FlowId
  readonly taskInputs: readonly DeliveryComposerTaskInputV2[]
  readonly dependencyOrder: readonly TaskChangeSetId[]
  readonly allowOrderedSameFileChanges?: boolean
}): ResolveTaskChangeSetFilesResultV2 {
  if (input.taskInputs.length === 0) return conflictV2('NO_TASK_CHANGESETS', [])
  const selectedIds = input.taskInputs.map((task) => task.changeSet.taskChangeSetId)
  const selectedIdSet = new Set(selectedIds)
  if (selectedIdSet.size !== selectedIds.length) return conflictV2('DEPENDENCY_ORDER_INVALID', [])

  const dependencyCheck = validateDependencyClosure(input.taskInputs, input.dependencyOrder)
  if (!dependencyCheck.ok) {
    return conflictV2(dependencyCheck.reasonCode as DeliveryCompositionConflictCodeV2, dependencyCheck.conflicts)
  }

  const orderedInputs = new Map(input.taskInputs.map((task) => [task.changeSet.taskChangeSetId, task]))
  const files: DeliveryIntegrationFileV2[] = []
  const refs: DeliveryTaskChangeSetRefV1[] = []
  for (const taskChangeSetId of input.dependencyOrder) {
    const task = orderedInputs.get(taskChangeSetId)
    if (!task) continue
    const changeSet = task.changeSet
    if (changeSet.flowId !== input.flowId) return conflictV2('TASK_FLOW_MISMATCH', [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    if (taskChangeSetDigestV1(changeSet) !== changeSet.digest) {
      return conflictV2('TASK_CHANGESET_DIGEST_DRIFT', [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    }
    if (changeSet.patchArtifactId !== task.patchArtifact.artifactId) {
      return conflictV2('PATCH_ARTIFACT_BINDING_MISMATCH', [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    }
    if (digestBytes(task.patchArtifact.bytes) !== task.patchArtifact.digest) {
      return conflictV2('PATCH_ARTIFACT_DIGEST_DRIFT', [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    }

    const patch = parsePatchArtifactV2(task.patchArtifact.bytes)
    if (!patch.ok) return conflictV2(patch.reasonCode, [{ taskChangeSetIds: [changeSet.taskChangeSetId] }])
    refs.push({
      taskChangeSetId: changeSet.taskChangeSetId,
      taskRunId: changeSet.taskRunId,
      digest: changeSet.digest,
      patchArtifactId: changeSet.patchArtifactId,
      dependsOn: changeSet.ancestorTaskChangeSetIds,
    })

    for (const file of patch.files) {
      let normalized: string
      try {
        normalized = normalizeRelativePath(file.relativePath)
      } catch {
        return conflictV2('PATCH_ARTIFACT_INVALID', [{ relativePath: file.relativePath, taskChangeSetIds: [changeSet.taskChangeSetId] }])
      }
      const rename = file.rename
      if (file.operation === 'DELETE') {
        if (
          typeof file.baselineDigest !== 'string' ||
          file.baselineDigest.length === 0 ||
          file.contentDigest !== null ||
          'contentBase64' in file
        ) {
          return conflictV2('PATCH_ARTIFACT_INVALID', [{ relativePath: normalized, taskChangeSetIds: [changeSet.taskChangeSetId] }])
        }
        files.push({
          operation: 'DELETE',
          relativePath: normalized,
          baselineDigest: file.baselineDigest as Sha256Digest,
          contentDigest: null,
          sourceTaskChangeSetId: changeSet.taskChangeSetId,
          ...(rename ? { rename } : {}),
        })
        continue
      }
      if (file.operation !== 'CREATE' && file.operation !== 'MODIFY') {
        return conflictV2('PATCH_ARTIFACT_INVALID', [{ relativePath: normalized, taskChangeSetIds: [changeSet.taskChangeSetId] }])
      }
      if (
        typeof file.contentBase64 !== 'string' ||
        typeof file.contentDigest !== 'string' ||
        file.contentDigest.length === 0 ||
        (file.operation === 'CREATE' && file.baselineDigest !== null) ||
        (file.operation === 'MODIFY' && typeof file.baselineDigest !== 'string')
      ) {
        return conflictV2('PATCH_ARTIFACT_INVALID', [{ relativePath: normalized, taskChangeSetIds: [changeSet.taskChangeSetId] }])
      }
      const content = Buffer.from(file.contentBase64, 'base64')
      if (digestBytes(content) !== file.contentDigest) {
        return conflictV2('PATCH_FILE_DIGEST_DRIFT', [{ relativePath: normalized, taskChangeSetIds: [changeSet.taskChangeSetId] }])
      }
      files.push({
        operation: file.operation,
        relativePath: normalized,
        baselineDigest: file.baselineDigest as Sha256Digest,
        contentDigest: file.contentDigest as Sha256Digest,
        contentArtifactId: deliveryFileContentArtifactId({
          relativePath: normalized,
          contentDigest: file.contentDigest as Sha256Digest,
          sourceTaskChangeSetId: changeSet.taskChangeSetId,
        }),
        content,
        sourceTaskChangeSetId: changeSet.taskChangeSetId,
        ...(rename ? { rename } : {}),
      } as DeliveryIntegrationFileV2)
    }
  }

  const renameConflict = validateRenameLinksV2(files)
  if (renameConflict) return conflictV2('RENAME_INVALID', [renameConflict])
  if (!input.allowOrderedSameFileChanges) {
    const sameFileConflict = findSameFileConflictV2(files)
    if (sameFileConflict) return conflictV2('SAME_FILE_NON_DETERMINISTIC', [sameFileConflict])
  }
  return { ok: true, files, refs }
}

export class DeliveryComposerV2 {
  constructor(private readonly options: { readonly integrationWorktree: DeliveryIntegrationWorktreePortV2 }) {}

  async compose(input: ComposeDeliveryInputV2): Promise<ComposeDeliveryResultV2> {
    const resolved = resolveTaskChangeSetFilesV2(input)
    if (!resolved.ok) return resolved
    const integration = await this.options.integrationWorktree.integrateV2(resolved.files)
    const artifacts = resolved.files
      .filter((file): file is Exclude<DeliveryIntegrationFileV2, { operation: 'DELETE' }> => file.operation !== 'DELETE')
      .map((file): DeliveryComposedFileArtifactV1 => ({
        artifactId: file.contentArtifactId,
        contentDigest: file.contentDigest,
        kind: 'DELIVERY_FILE_CONTENT',
        mediaType: 'application/vnd.xiaogui.delivery-file-content',
        content: file.content,
      }))
    const fileChanges = resolved.files.map((file): DeliveryFileChangeSummaryV2 => {
      if (file.operation === 'DELETE') {
        return {
          operation: 'DELETE',
          relativePath: file.relativePath,
          baselineDigest: file.baselineDigest,
          contentDigest: null,
          sourceTaskChangeSetIds: [file.sourceTaskChangeSetId],
          ...(file.rename ? { rename: file.rename } : {}),
        }
      }
      if (file.operation === 'MODIFY') {
        return {
          operation: 'MODIFY',
          relativePath: file.relativePath,
          baselineDigest: file.baselineDigest,
          contentDigest: file.contentDigest,
          contentArtifactId: file.contentArtifactId,
          sourceTaskChangeSetIds: [file.sourceTaskChangeSetId],
          ...(file.rename ? { rename: file.rename } : {}),
        }
      }
      return {
        operation: 'CREATE',
        relativePath: file.relativePath,
        baselineDigest: null,
        contentDigest: file.contentDigest,
        contentArtifactId: file.contentArtifactId,
        sourceTaskChangeSetIds: [file.sourceTaskChangeSetId],
        ...(file.rename ? { rename: file.rename } : {}),
      }
    })
    const changeSetWithoutDigest = {
      kind: 'DELIVERY_CHANGESET' as const,
      version: 2 as const,
      deliveryChangeSetId: input.deliveryChangeSetId,
      batchId: input.deliveryBatchId,
      selectionDraftId: input.selectionDraftId,
      flowId: input.flowId,
      selectionDigest: input.selectionDigest,
      taskChangeSetIds: resolved.refs.map((ref) => ref.taskChangeSetId),
      taskChangeSets: resolved.refs,
      dependencyOrder: input.dependencyOrder,
      fileChanges,
      target: input.target,
      integrationTreeHash: integration.integrationTreeHash,
      evidenceArtifactIds: [],
      qaConfigVersion: input.qaConfigVersion,
      createdAt: input.createdAt,
    }
    return {
      ok: true,
      changeSet: { ...changeSetWithoutDigest, digest: deliveryChangeSetDigestV2(changeSetWithoutDigest) },
      files: resolved.files,
      artifacts,
      privateIntegrationContext: integration.privateIntegrationContext,
    }
  }
}

function parsePatchArtifactV2(bytes: Uint8Array):
  | { ok: true; files: readonly TaskPatchFileSnapshotV2[] }
  | { ok: false; reasonCode: DeliveryCompositionConflictCodeV2 } {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as TaskPatchArtifactV2
    if (parsed?.kind !== 'TASK_PATCH_V2' || parsed.version !== 2 || !Array.isArray(parsed.files)) {
      return { ok: false, reasonCode: 'PATCH_ARTIFACT_INVALID' }
    }
    return { ok: true, files: parsed.files }
  } catch {
    return { ok: false, reasonCode: 'PATCH_ARTIFACT_INVALID' }
  }
}

function validateRenameLinksV2(
  files: readonly DeliveryIntegrationFileV2[],
): { readonly relativePath: string; readonly taskChangeSetIds: readonly TaskChangeSetId[] } | null {
  const byGroup = new Map<string, DeliveryIntegrationFileV2[]>()
  for (const file of files) {
    if (!file.rename) continue
    let counterpartPath: string
    try {
      counterpartPath = normalizeRelativePath(file.rename.counterpartPath)
    } catch {
      return { relativePath: file.relativePath, taskChangeSetIds: [file.sourceTaskChangeSetId] }
    }
    if (!file.rename.groupId.trim() || counterpartPath === file.relativePath) {
      return { relativePath: file.relativePath, taskChangeSetIds: [file.sourceTaskChangeSetId] }
    }
    const group = byGroup.get(file.rename.groupId) ?? []
    group.push(file)
    byGroup.set(file.rename.groupId, group)
  }
  for (const [groupId, group] of byGroup) {
    if (
      group.length !== 2 ||
      group[0].rename?.groupId !== groupId ||
      group[1].rename?.groupId !== groupId ||
      new Set(group.map((file) => file.relativePath)).size !== 2
    ) {
      return {
        relativePath: group[0]?.relativePath,
        taskChangeSetIds: group.map((file) => file.sourceTaskChangeSetId),
      }
    }
    const source = group.find((file) => file.rename?.role === 'SOURCE')
    const target = group.find((file) => file.rename?.role === 'TARGET')
    if (
      !source ||
      !target ||
      source.operation !== 'DELETE' ||
      target.operation !== 'CREATE' ||
      normalizeRenameCounterpartV2(source) !== target.relativePath ||
      normalizeRenameCounterpartV2(target) !== source.relativePath
    ) {
      return {
        relativePath: group[0]?.relativePath,
        taskChangeSetIds: group.map((file) => file.sourceTaskChangeSetId),
      }
    }
  }
  return null
}

function normalizeRenameCounterpartV2(file: DeliveryIntegrationFileV2): string | null {
  if (!file.rename) return null
  try {
    return normalizeRelativePath(file.rename.counterpartPath)
  } catch {
    return null
  }
}

function findSameFileConflictV2(
  files: readonly DeliveryIntegrationFileV2[],
): { readonly relativePath: string; readonly taskChangeSetIds: readonly TaskChangeSetId[] } | null {
  const byPath = new Map<string, DeliveryIntegrationFileV2[]>()
  for (const file of files) {
    const key = process.platform === 'win32' ? file.relativePath.toLowerCase() : file.relativePath
    const values = byPath.get(key) ?? []
    values.push(file)
    byPath.set(key, values)
  }
  for (const filesForPath of byPath.values()) {
    if (filesForPath.length > 1) {
      return {
        relativePath: filesForPath[0].relativePath,
        taskChangeSetIds: filesForPath.map((file) => file.sourceTaskChangeSetId),
      }
    }
  }
  return null
}

function conflictV2(
  reasonCode: DeliveryCompositionConflictCodeV2,
  conflicts: readonly { readonly relativePath?: string; readonly taskChangeSetIds: readonly TaskChangeSetId[] }[],
): Extract<ComposeDeliveryResultV2, { ok: false }> {
  return { ok: false, reasonCode, conflicts }
}

function deliveryFileContentArtifactId(input: {
  readonly relativePath: string
  readonly contentDigest: Sha256Digest
  readonly sourceTaskChangeSetId: TaskChangeSetId
}): ArtifactId {
  const hex = createHash('sha256').update(JSON.stringify({
    kind: 'DELIVERY_FILE_CONTENT_ID_V1',
    relativePath: input.relativePath,
    contentDigest: input.contentDigest,
    sourceTaskChangeSetId: input.sourceTaskChangeSetId,
  })).digest('hex')
  return `xhbdart_file_${hex.slice(0, 32)}` as ArtifactId
}

function validateDependencyClosure(
  taskInputs: readonly DeliveryComposerTaskInputV1[],
  dependencyOrder: readonly TaskChangeSetId[],
): ComposeDeliveryResultV1 | { ok: true } {
  const selected = new Set(taskInputs.map((task) => task.changeSet.taskChangeSetId))
  const orderPosition = new Map(dependencyOrder.map((id, index) => [id, index]))
  if (dependencyOrder.length !== selected.size || dependencyOrder.some((id) => !selected.has(id))) {
    return conflict('DEPENDENCY_ORDER_INVALID', [])
  }
  for (const task of taskInputs) {
    const currentPosition = orderPosition.get(task.changeSet.taskChangeSetId)
    if (currentPosition === undefined) return conflict('DEPENDENCY_ORDER_INVALID', [])
    for (const ancestor of task.changeSet.ancestorTaskChangeSetIds) {
      if (!selected.has(ancestor)) {
        return conflict('DEPENDENCY_CLOSURE_INCOMPLETE', [{ taskChangeSetIds: [task.changeSet.taskChangeSetId, ancestor] }])
      }
      const ancestorPosition = orderPosition.get(ancestor)
      if (ancestorPosition === undefined || ancestorPosition >= currentPosition) {
        return conflict('DEPENDENCY_ORDER_INVALID', [{ taskChangeSetIds: [ancestor, task.changeSet.taskChangeSetId] }])
      }
    }
  }
  return { ok: true }
}

function parsePatchArtifact(bytes: Uint8Array):
  | { ok: true; files: readonly TaskPatchFileSnapshotV1[] }
  | { ok: false; reasonCode: DeliveryCompositionConflictCodeV1 } {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as TaskPatchArtifactV1
    if (
      parsed?.kind !== 'TASK_PATCH_V1' ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.files)
    ) {
      return { ok: false, reasonCode: 'PATCH_ARTIFACT_INVALID' }
    }
    return { ok: true, files: parsed.files }
  } catch {
    return { ok: false, reasonCode: 'PATCH_ARTIFACT_INVALID' }
  }
}

function findSameFileConflict(
  files: readonly DeliveryIntegrationFileV1[],
): { readonly relativePath: string; readonly taskChangeSetIds: readonly TaskChangeSetId[] } | null {
  const byPath = new Map<string, TaskChangeSetId[]>()
  for (const file of files) {
    const taskIds = byPath.get(file.relativePath) ?? []
    taskIds.push(file.sourceTaskChangeSetId)
    byPath.set(file.relativePath, taskIds)
  }
  for (const [relativePath, taskChangeSetIds] of byPath) {
    if (new Set(taskChangeSetIds).size > 1) return { relativePath, taskChangeSetIds }
  }
  return null
}

function conflict(
  reasonCode: DeliveryCompositionConflictCodeV1,
  conflicts: readonly { readonly relativePath?: string; readonly taskChangeSetIds: readonly TaskChangeSetId[] }[],
): Extract<ComposeDeliveryResultV1, { ok: false }> {
  return { ok: false, reasonCode, conflicts }
}

function normalizeRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\0') ||
    value.includes(':') ||
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  ) {
    throw new Error('PATH_FORBIDDEN')
  }
  const normalized = value.replace(/[\\]+/g, '/')
  const parts = normalized.split('/')
  if (
    parts.includes('..') ||
    parts.includes('.') ||
    parts.includes('') ||
    parts.some((part) => part.toLowerCase() === '.git')
  ) {
    throw new Error('PATH_FORBIDDEN')
  }
  return posix.normalize(normalized)
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}
