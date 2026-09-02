import { describe, expect, it } from 'vitest'

import type { FlowId, TaskRunId } from './xiaogui-collaboration-hub'
import {
  deliveryChangeSetDigestV1,
  deliveryGateSubjectDigestV1,
  deliverySelectionDraftDigestV1,
  type DeliveryBatchId,
  type DeliveryChangeSetId,
  type DeliverySelectionDraftId,
} from './xiaogui-delivery'
import type { ArtifactId, IsoDateTime, Sha256Digest, TaskChangeSetId } from './xiaogui-task-verification'

const FLOW_ID = 'flow_delivery' as FlowId
const BATCH_ID = 'xhbd_batch' as DeliveryBatchId
const DRAFT_ID = 'xhbd_draft' as DeliverySelectionDraftId
const CHANGESET_ID = 'xhbd_cs' as DeliveryChangeSetId
const TASK_CHANGESET_ID = 'xhbcs_task' as TaskChangeSetId
const TASK_RUN_ID = 'xhbr_task' as TaskRunId
const PATCH_ARTIFACT_ID = 'xhart_patch' as ArtifactId
const DIGEST = `sha256:${'1'.repeat(64)}` as Sha256Digest
const TREE = `sha256:${'2'.repeat(64)}` as Sha256Digest
const FINGERPRINT = `sha256:${'3'.repeat(64)}` as Sha256Digest
const CREATED_AT = '2026-08-17T12:00:00.000Z' as IsoDateTime

describe('xiaogui delivery contract', () => {
  it('creates a stable selection digest without absolute paths or private logs', () => {
    const draft = {
      kind: 'DELIVERY_SELECTION_DRAFT' as const,
      version: 1 as const,
      draftId: DRAFT_ID,
      batchId: BATCH_ID,
      selectionDraftId: DRAFT_ID,
      deliveryBatchId: BATCH_ID,
      flowId: FLOW_ID,
      selectedTaskRunIds: [TASK_RUN_ID],
      resolvedTaskChangeSets: [{
        taskRunId: TASK_RUN_ID,
        taskChangeSetId: TASK_CHANGESET_ID,
        digest: DIGEST,
        patchArtifactId: PATCH_ARTIFACT_ID,
      }],
      dependencyTaskRunIds: [TASK_RUN_ID],
      taskChangeSetIds: [TASK_CHANGESET_ID],
      dependencyOrder: [TASK_CHANGESET_ID],
      baselineTreeHash: TREE,
      targetFingerprint: FINGERPRINT,
      createdAt: CREATED_AT,
    }

    const first = deliverySelectionDraftDigestV1(draft)
    const second = deliverySelectionDraftDigestV1({ ...draft })

    expect(first).toBe(second)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(draft)).not.toContain('D:\\')
  })

  it('binds user approval to delivery id, version and digest', () => {
    const subject = {
      deliveryChangeSetId: CHANGESET_ID,
      version: 1 as const,
      digest: DIGEST,
    }

    expect(deliveryGateSubjectDigestV1(subject)).toBe(deliveryGateSubjectDigestV1({ ...subject }))
    expect(deliveryGateSubjectDigestV1({
      ...subject,
      digest: `sha256:${'4'.repeat(64)}` as Sha256Digest,
    })).not.toBe(deliveryGateSubjectDigestV1(subject))
  })

  it('keeps the delivery changeset digest stable over public task and file summaries', () => {
    const changeSet = {
      kind: 'DELIVERY_CHANGESET' as const,
      version: 1 as const,
      deliveryChangeSetId: CHANGESET_ID,
      batchId: BATCH_ID,
      selectionDraftId: DRAFT_ID,
      flowId: FLOW_ID,
      selectionDigest: DIGEST,
      taskChangeSetIds: [TASK_CHANGESET_ID],
      taskChangeSets: [{
        taskChangeSetId: TASK_CHANGESET_ID,
        taskRunId: TASK_RUN_ID,
        digest: DIGEST,
        patchArtifactId: PATCH_ARTIFACT_ID,
        dependsOn: [],
      }],
      dependencyOrder: [TASK_CHANGESET_ID],
      fileChanges: [{
        operation: 'MODIFY' as const,
        relativePath: 'src/feature.ts',
        baselineDigest: DIGEST,
        contentDigest: TREE,
        contentArtifactId: PATCH_ARTIFACT_ID,
        sourceTaskChangeSetIds: [TASK_CHANGESET_ID],
      }],
      target: {
        projectId: 'xgp_project',
        baseRevision: '1'.repeat(40),
        baselineTreeHash: '2'.repeat(40),
        initialTargetFingerprint: FINGERPRINT,
      },
      integrationTreeHash: FINGERPRINT,
      evidenceArtifactIds: [PATCH_ARTIFACT_ID],
      qaConfigVersion: 'xiaogui.coding.delivery.v1',
      createdAt: CREATED_AT,
    }

    expect(deliveryChangeSetDigestV1(changeSet)).toBe(deliveryChangeSetDigestV1({ ...changeSet }))
    expect(JSON.stringify(changeSet)).not.toContain('private')
    expect(JSON.stringify(changeSet)).not.toContain('contentBase64')
  })
})
