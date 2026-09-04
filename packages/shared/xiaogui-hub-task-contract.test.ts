import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  canonicalizeXiaoguiTaskResultEnvelopeV1,
  parseXiaoguiTaskResultSubmissionV1,
} from './xiaogui-hub-task-contract'

const PACKAGE_SHA256 = `sha256:${'a'.repeat(64)}`

function submission() {
  const result = {
    schemaVersion: 'xiaogui.task-result.v1' as const,
    resultId: 'xgh_result_1',
    assignmentId: 'xgh_assignment_1',
    taskId: 'xgh_task_1',
    outcome: 'RESULT_READY' as const,
    resultSummary: '本机已形成通过受控验证的交付候选，仍需人工批准。',
    artifactRefs: [{
      artifactId: 'xhbdcs_1',
      mediaType: 'application/vnd.xiaogui.delivery-changeset-ref+json',
      sha256: `sha256:${'b'.repeat(64)}`,
    }],
    verification: { verdict: 'PASS' as const, summary: '本机交付验证已通过。' },
    occurredAt: '2026-09-04T00:00:00.000Z',
  }
  const resultSha256 = `sha256:${createHash('sha256').update(canonicalizeXiaoguiTaskResultEnvelopeV1(result), 'utf8').digest('hex')}`
  return {
    result: { ...result, resultSha256 },
    receipt: {
      schemaVersion: 'xiaogui.task-receipt.v1',
      eventId: 'xgh_event_result_1',
      assignmentId: result.assignmentId,
      taskId: result.taskId,
      subjectId: 'xgh_subject_1',
      nodeId: 'xgh_node_1',
      keyId: 'ed25519:test-key',
      eventType: 'RESULT_READY',
      packageSha256: PACKAGE_SHA256,
      occurredAt: result.occurredAt,
      sequence: 3,
      resultSha256,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
  }
}

describe('H1-4C result wire contract', () => {
  it('accepts a matching terminal envelope and receipt with the frozen ordered result digest', () => {
    const parsed = parseXiaoguiTaskResultSubmissionV1(submission())
    expect(parsed).toEqual(expect.objectContaining({ ok: true }))
  })

  it('rejects mismatched terminal event data and local paths in controlled summaries', () => {
    const mismatch = submission()
    mismatch.receipt.eventType = 'EXECUTION_FAILED'
    expect(parseXiaoguiTaskResultSubmissionV1(mismatch).ok).toBe(false)

    const unsafe = submission()
    unsafe.result.resultSummary = '结果保存在 D:\\private\\result.txt'
    expect(parseXiaoguiTaskResultSubmissionV1(unsafe).ok).toBe(false)
  })
})
