import { expect, it, vi } from 'vitest'
import { createHubTaskWorkerStateStoreV1 } from './worker-state'
import { createHubTaskWorkerStatePersistenceV1 } from './worker-persistence'
import { projectHubTaskResultFromExecutionTerminalV1 } from './task-result-projection'

// The backing is synthetic; no Electron user profile is opened.
vi.mock('electron-store', () => ({ default: class {} }))
const now = '2026-09-09T00:00:00.000Z'
const digest = `sha256:${'a'.repeat(64)}`
const node = { subjectId: 'subject', nodeId: 'node', keyId: 'key', deviceToken: 'SYNTHETIC_TOKEN', privateKeyPem: 'SYNTHETIC_KEY' }
const identity = { subjectId: 'subject', nodeId: 'node', keyId: 'key' }
const detail = {
  assignment: { assignmentId: 'assignment', taskId: 'task', decisionState: 'ACCEPTED' as const, deliveryState: 'QUEUED' as const,
    executionState: 'NOT_STARTED' as const, createdAt: now, updatedAt: now },
  offer: { taskId: 'task', mode: 'DIRECT' as const, title: 'task', taskContent: 'content', constraints: [], acceptanceRequirements: [], attachmentRefs: [], packageSha256: digest },
}
const receipt = { schemaVersion: 'xiaogui.task-receipt.v1' as const, eventId: 'event', assignmentId: 'assignment', taskId: 'task',
  ...identity, sequence: 1, eventType: 'NODE_STORED' as const, packageSha256: digest, occurredAt: now, resultSha256: null,
  signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }

it.each(['new write', 'legacy restore'] as const)('projects only three identity IDs across actual persistence on %s', mode => {
  let stored: unknown
  const writes: unknown[] = []
  const persistence = createHubTaskWorkerStatePersistenceV1({
    get: () => stored,
    set: (_key, value) => { stored = structuredClone(value); writes.push(stored) },
  })
  let state = createHubTaskWorkerStateStoreV1(persistence)
  state.enqueueReceipt(receipt, now)
  const result = projectHubTaskResultFromExecutionTerminalV1({ resultId: 'result', assignmentId: 'assignment', taskId: 'task', occurredAt: now, verificationState: 'NOT_RUN' })
  const submission = { result, receipt: { ...receipt, eventId: 'result-event', sequence: 2, eventType: 'EXECUTION_FAILED' as const, resultSha256: result.resultSha256 } }
  state.enqueueResult(submission, now)
  const resultBytes = JSON.stringify(state.snapshot().results?.result.submission)
  if (mode === 'new write') {
    state.upsertAssignment(detail, node)
  } else {
    state.upsertAssignment(detail, identity)
    const legacy = state.snapshot()
    legacy.assignments.assignment.deliveryIdentity = node
    stored = legacy
    writes.length = 0
    state = createHubTaskWorkerStateStoreV1(persistence)
    expect(state.snapshot().assignments.assignment.deliveryIdentity).toEqual(identity)
    state.setCursor('next')
  }
  expect(state.requireAssignment('assignment').deliveryIdentity).toEqual(identity)
  expect(state.snapshot().assignments.assignment.deliveryIdentity).toEqual(identity)
  expect(state.pendingEvidence()[0]).toMatchObject({ receipt })
  expect(JSON.stringify(state.snapshot().receipts.event.receipt)).toBe(JSON.stringify(receipt))
  expect(JSON.stringify(state.snapshot().results?.result.submission)).toBe(resultBytes)
  for (const write of writes) {
    expect(JSON.stringify(write)).not.toContain('SYNTHETIC_TOKEN')
    expect(JSON.stringify(write)).not.toContain('SYNTHETIC_KEY')
  }
})
