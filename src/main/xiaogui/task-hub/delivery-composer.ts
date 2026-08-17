import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

import type { FlowId } from '@shared/xiaogui-collaboration-hub'
import {
  deliveryChangeSetDigestV1,
  type DeliveryBatchId,
  type DeliveryChangeSetId,
  type DeliveryChangeSetV1,
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

import type { TaskPatchArtifactV1, TaskPatchFileSnapshotV1 } from './attempt-workspace'

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

export class DeliveryComposerV1 {
  constructor(private readonly integrationWorktree: DeliveryIntegrationWorktreePortV1) {}

  async compose(input: ComposeDeliveryInputV1): Promise<ComposeDeliveryResultV1> {
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
        const contentArtifactId = deliveryFileContentArtifactId({
          relativePath: normalized,
          contentDigest: file.contentDigest as Sha256Digest,
          sourceTaskChangeSetId: changeSet.taskChangeSetId,
        })
        files.push({
          operation: file.operation,
          relativePath: normalized,
          baselineDigest: file.baselineDigest as Sha256Digest | null,
          contentDigest: file.contentDigest as Sha256Digest,
          contentArtifactId,
          content,
          sourceTaskChangeSetId: changeSet.taskChangeSetId,
        })
      }
    }

    const sameFileConflict = findSameFileConflict(files)
    if (sameFileConflict) return conflict('SAME_FILE_NON_DETERMINISTIC', [sameFileConflict])

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
): ComposeDeliveryResultV1 {
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
