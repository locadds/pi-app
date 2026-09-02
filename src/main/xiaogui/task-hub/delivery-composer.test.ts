import { describe, expect, it, vi } from 'vitest'

import type { AttemptId, FlowId, PlanRevisionId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import {
  type DeliveryBatchId,
  type DeliveryChangeSetId,
  type DeliverySelectionDraftId,
} from '@shared/xiaogui-delivery'
import {
  taskChangeSetDigestV1,
  type ArtifactId,
  type EvidenceBundleId,
  type IsoDateTime,
  type QaResultId,
  type Sha256Digest,
  type TaskChangeSetCandidateId,
  type TaskChangeSetId,
  type TaskChangeSetV1,
  type VerificationAttemptId,
} from '@shared/xiaogui-task-verification'

import { digestBytes } from './attempt-workspace'
import {
  DeliveryComposerV1,
  type DeliveryIntegrationWorktreePortV1,
} from './delivery-composer'

const FLOW_ID = 'xhbf_flow' as FlowId
const PLAN_REVISION_ID = 'xhbpr_plan' as PlanRevisionId
const BATCH_ID = 'xhbd_batch' as DeliveryBatchId
const DRAFT_ID = 'xhbd_draft' as DeliverySelectionDraftId
const DELIVERY_CHANGESET_ID = 'xhbdcs_delivery' as DeliveryChangeSetId
const CREATED_AT = '2026-08-17T12:00:00.000Z' as IsoDateTime
const BASELINE_TREE = `sha256:${'a'.repeat(64)}` as Sha256Digest
const TARGET_FINGERPRINT = `sha256:${'b'.repeat(64)}` as Sha256Digest
const INTEGRATION_TREE = `sha256:${'c'.repeat(64)}` as Sha256Digest

describe('DeliveryComposerV1', () => {
  it('combines two dependency-ordered, non-overlapping task changesets into a public delivery changeset', async () => {
    const first = taskInput('one', [{ operation: 'MODIFY', relativePath: 'src/a.ts', before: 'a0', after: 'a1' }])
    const second = taskInput(
      'two',
      [{ operation: 'CREATE', relativePath: 'src/b.ts', after: 'b1' }],
      [first.changeSet.taskChangeSetId],
    )
    const integrate = vi.fn<DeliveryIntegrationWorktreePortV1['integrate']>().mockResolvedValue({
      integrationTreeHash: INTEGRATION_TREE,
      privateIntegrationContext: {
        worktreeRoot: 'D:\\private\\delivery-worktree',
        trustedToolchainRoot: 'D:\\private\\toolchain',
      },
    })
    const composer = new DeliveryComposerV1({ integrate })

    const result = await composer.compose(baseInput([first, second], [
      first.changeSet.taskChangeSetId,
      second.changeSet.taskChangeSetId,
    ]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(integrate).toHaveBeenCalledOnce()
    expect(integrate.mock.calls[0][0].map((file) => file.relativePath)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.changeSet).toMatchObject({
      kind: 'DELIVERY_CHANGESET',
      version: 1,
      flowId: FLOW_ID,
      integrationTreeHash: INTEGRATION_TREE,
      target: {
        initialTargetFingerprint: TARGET_FINGERPRINT,
      },
    })
    expect(result.changeSet.taskChangeSets.map((task) => task.taskChangeSetId)).toEqual([
      first.changeSet.taskChangeSetId,
      second.changeSet.taskChangeSetId,
    ])
    expect(result.changeSet.fileChanges.map((file) => file.relativePath)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.changeSet.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(result.changeSet)).not.toContain('D:\\private')
    expect(result.privateIntegrationContext.worktreeRoot).toContain('delivery-worktree')
  })

  it('rejects a selected task when its dependency closure is missing', async () => {
    const dependencyId = 'xhbcs_missing' as TaskChangeSetId
    const selected = taskInput('selected', [{ operation: 'MODIFY', relativePath: 'src/a.ts', before: 'a0', after: 'a1' }], [dependencyId])
    const composer = new DeliveryComposerV1({ integrate: vi.fn() })

    const result = await composer.compose(baseInput([selected], [selected.changeSet.taskChangeSetId]))

    expect(result).toMatchObject({ ok: false, reasonCode: 'DEPENDENCY_CLOSURE_INCOMPLETE' })
  })

  it('rejects same-file changes because the merge is not deterministic', async () => {
    const first = taskInput('one', [{ operation: 'MODIFY', relativePath: 'src/a.ts', before: 'a0', after: 'a1' }])
    const second = taskInput('two', [{ operation: 'MODIFY', relativePath: 'src/a.ts', before: 'a1', after: 'a2' }])
    const composer = new DeliveryComposerV1({ integrate: vi.fn() })

    const result = await composer.compose(baseInput([first, second], [
      first.changeSet.taskChangeSetId,
      second.changeSet.taskChangeSetId,
    ]))

    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'SAME_FILE_NON_DETERMINISTIC',
      conflicts: [{ relativePath: 'src/a.ts' }],
    })
  })

  it('rejects patch artifact digest drift before touching the integration worktree', async () => {
    const selected = taskInput('selected', [{ operation: 'MODIFY', relativePath: 'src/a.ts', before: 'a0', after: 'a1' }])
    const integrate = vi.fn<DeliveryIntegrationWorktreePortV1['integrate']>()
    const composer = new DeliveryComposerV1({ integrate })

    const result = await composer.compose(baseInput([{
      ...selected,
      patchArtifact: {
        ...selected.patchArtifact,
        digest: `sha256:${'0'.repeat(64)}` as Sha256Digest,
      },
    }], [selected.changeSet.taskChangeSetId]))

    expect(result).toMatchObject({ ok: false, reasonCode: 'PATCH_ARTIFACT_DIGEST_DRIFT' })
    expect(integrate).not.toHaveBeenCalled()
  })
})

function baseInput(taskInputs: ReturnType<typeof taskInput>[], dependencyOrder: TaskChangeSetId[]) {
  return {
    flowId: FLOW_ID,
    deliveryBatchId: BATCH_ID,
    selectionDraftId: DRAFT_ID,
    deliveryChangeSetId: DELIVERY_CHANGESET_ID,
    taskInputs,
    dependencyOrder,
    baselineTreeHash: BASELINE_TREE,
    selectionDigest: `sha256:${'d'.repeat(64)}` as Sha256Digest,
    target: {
      projectId: 'xgp_project',
      baseRevision: '1'.repeat(40),
      baselineTreeHash: '2'.repeat(40),
      initialTargetFingerprint: TARGET_FINGERPRINT,
    },
    qaConfigVersion: 'xiaogui.coding.delivery.v1',
    createdAt: CREATED_AT,
  }
}

function taskInput(
  suffix: string,
  files: readonly (
    | { operation: 'MODIFY'; relativePath: string; before: string; after: string }
    | { operation: 'CREATE'; relativePath: string; after: string }
  )[],
  ancestors: readonly TaskChangeSetId[] = [],
) {
  const taskChangeSetId = `xhbcs_${suffix}` as TaskChangeSetId
  const patchArtifactId = `xhart_${suffix}` as ArtifactId
  const patchFiles = files.map((file) => {
    const content = Buffer.from(file.after)
    return {
      operation: file.operation,
      relativePath: file.relativePath,
      baselineDigest: file.operation === 'MODIFY' ? digestBytes(file.before) : null,
      contentDigest: digestBytes(content),
      contentBase64: content.toString('base64'),
    }
  })
  const bytes = Buffer.from(JSON.stringify({ kind: 'TASK_PATCH_V1', version: 1, files: patchFiles }))
  const withoutDigest = {
    kind: 'TASK' as const,
    taskChangeSetId,
    version: 1 as const,
    flowId: FLOW_ID,
    planRevisionId: PLAN_REVISION_ID,
    taskRunId: `xhbr_${suffix}` as TaskRunId,
    attemptId: `xhba_${suffix}` as AttemptId,
    verificationAttemptId: `xhbva_${suffix}` as VerificationAttemptId,
    candidateId: `xhcand_${suffix}` as TaskChangeSetCandidateId,
    inputTreeHash: BASELINE_TREE,
    resultTreeHash: `sha256:${createPaddedHex(suffix, '1')}` as Sha256Digest,
    ancestorTaskChangeSetIds: ancestors,
    patchArtifactId,
    evidenceBundleId: `xhbev_${suffix}` as EvidenceBundleId,
    qaResultId: `xhbqa_${suffix}` as QaResultId,
    qaConfigVersion: 'xiaogui.coding.task.v1',
    createdAt: CREATED_AT,
  }
  const changeSet: TaskChangeSetV1 = {
    ...withoutDigest,
    digest: taskChangeSetDigestV1(withoutDigest),
  }
  return {
    changeSet,
    patchArtifact: {
      artifactId: patchArtifactId,
      digest: digestBytes(bytes) as Sha256Digest,
      bytes,
    },
  }
}

function createPaddedHex(seed: string, char: string): string {
  return `${Buffer.from(seed).toString('hex')}${char.repeat(64)}`.slice(0, 64)
}
