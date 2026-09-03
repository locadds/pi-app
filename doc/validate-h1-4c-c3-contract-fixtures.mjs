import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(new URL('./H1-4C-C3-CONTRACT-FIXTURES.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

const ERROR_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'VERSION_CONFLICT',
  'RELEASE_NOT_APPROVED',
  'INTENT_EXPIRED',
  'INTENT_ALREADY_CLAIMED',
  'DOWNSTREAM_UNAVAILABLE',
])

const RECEIPT_KEYS = [
  'schemaVersion',
  'eventId',
  'assignmentId',
  'taskId',
  'subjectId',
  'nodeId',
  'keyId',
  'eventType',
  'packageSha256',
  'occurredAt',
  'sequence',
  'resultSha256',
  'signature',
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function objectOf(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}

function hasExactKeys(value, keys, label) {
  const actual = Object.keys(objectOf(value, label)).sort()
  const expected = [...keys].sort()
  assert(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} has unexpected keys`)
}

function sha256(canonical) {
  return `sha256:${createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex')}`
}

function canonicalResult(result) {
  return JSON.stringify([
    result.schemaVersion,
    result.resultId,
    result.assignmentId,
    result.taskId,
    result.outcome,
    result.resultSummary,
    result.artifactRefs.map((ref) => [ref.artifactId, ref.mediaType, ref.sha256]),
    [result.verification.verdict, result.verification.summary],
    result.occurredAt,
  ])
}

function canonicalReceipt(receipt) {
  return JSON.stringify([
    receipt.schemaVersion,
    receipt.eventId,
    receipt.assignmentId,
    receipt.taskId,
    receipt.subjectId,
    receipt.nodeId,
    receipt.keyId,
    receipt.eventType,
    receipt.packageSha256,
    receipt.occurredAt,
    receipt.sequence,
    receipt.resultSha256,
  ])
}

function canonicalDemand(demand) {
  return JSON.stringify([
    demand.demandId,
    demand.demandVersion,
    demand.title,
    demand.problemStatement,
    demand.expectedOutcome,
    demand.backgroundSummary ?? null,
    demand.constraints,
    demand.attachmentRefs.map((ref) => [ref.ref, ref.sha256, ref.dataClassification]),
    demand.requestedDeadline ?? null,
    demand.capabilityHints,
    demand.acceptanceHints,
    demand.visibility,
  ])
}

function canonicalProjection(update) {
  const { projection } = update
  return JSON.stringify([
    update.schemaVersion,
    update.demandId,
    update.intakeId,
    [
      projection.projectionVersion,
      projection.demandId,
      projection.intakeId,
      projection.stage,
      projection.displaySummary,
      projection.updatedAt,
      projection.deliveryRef ?? null,
    ],
  ])
}

function assertHash(value, label) {
  assert(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value), `${label} must be a sha256: lowercase digest`)
}

function assertErrorEnvelope(response, label) {
  const error = objectOf(objectOf(response, label).error, `${label}.error`)
  hasExactKeys(error, ['code', 'messageKey', 'message', 'traceId'], `${label}.error`)
  assert(ERROR_CODES.has(error.code), `${label}.error.code must use the frozen C2 closure`)
  for (const field of ['messageKey', 'message', 'traceId']) {
    assert(typeof error[field] === 'string' && error[field].length > 0, `${label}.error.${field} is required`)
  }
}

function assertReceipt(receipt, binding, label) {
  hasExactKeys(receipt, RECEIPT_KEYS, label)
  assert(receipt.schemaVersion === 'xiaogui.task-receipt.v1', `${label}.schemaVersion is not the existing receipt schema`)
  assert(receipt.subjectId === binding.subjectId && receipt.nodeId === binding.nodeId && receipt.keyId === binding.keyId, `${label} binding mismatch`)
  assert(Number.isInteger(receipt.sequence) && receipt.sequence > 0, `${label}.sequence must be a positive integer`)
  assertHash(receipt.packageSha256, `${label}.packageSha256`)
  assertHash(receipt.resultSha256, `${label}.resultSha256`)
  assert(typeof receipt.signature === 'string' && receipt.signature.length > 0, `${label}.signature is required`)
  const valid = verify(
    null,
    Buffer.from(canonicalReceipt(receipt), 'utf8'),
    createPublicKey(binding.publicKeyPem),
    Buffer.from(receipt.signature, 'base64'),
  )
  assert(valid, `${label} Ed25519 signature does not verify`)
}

function assertResultSubmission(submission, binding, label) {
  const result = objectOf(objectOf(submission, label).result, `${label}.result`)
  const receipt = objectOf(submission.receipt, `${label}.receipt`)
  hasExactKeys(result, [
    'schemaVersion',
    'resultId',
    'assignmentId',
    'taskId',
    'outcome',
    'resultSummary',
    'artifactRefs',
    'verification',
    'occurredAt',
    'resultSha256',
  ], `${label}.result`)
  assert(result.schemaVersion === 'xiaogui.task-result.v1', `${label}.result schema is invalid`)
  assert(['RESULT_READY', 'EXECUTION_FAILED', 'OUTCOME_UNKNOWN'].includes(result.outcome), `${label}.result outcome is invalid`)
  assert(Array.isArray(result.artifactRefs), `${label}.result artifactRefs must be an array`)
  for (const [index, artifact] of result.artifactRefs.entries()) {
    hasExactKeys(artifact, ['artifactId', 'mediaType', 'sha256'], `${label}.result.artifactRefs[${index}]`)
    assertHash(artifact.sha256, `${label}.result.artifactRefs[${index}].sha256`)
  }
  hasExactKeys(result.verification, ['verdict', 'summary'], `${label}.result.verification`)
  assertHash(result.resultSha256, `${label}.result.resultSha256`)
  assert(result.resultSha256 === sha256(canonicalResult(result)), `${label}.result digest mismatch`)
  assertReceipt(receipt, binding, `${label}.receipt`)
  assert(receipt.assignmentId === result.assignmentId && receipt.taskId === result.taskId, `${label} result/receipt identity mismatch`)
  assert(receipt.eventType === result.outcome, `${label} result/receipt outcome mismatch`)
  assert(receipt.occurredAt === result.occurredAt, `${label} result/receipt occurredAt mismatch`)
  assert(receipt.resultSha256 === result.resultSha256, `${label} result/receipt digest mismatch`)
}

function assertTimeline(page, label) {
  const data = objectOf(objectOf(page, label).data, `${label}.data`)
  hasExactKeys(data, ['items', 'nextAfterSequence'], `${label}.data`)
  assert(Array.isArray(data.items), `${label}.data.items must be an array`)
  let previous = 0
  for (const [index, item] of data.items.entries()) {
    const entry = objectOf(item, `${label}.data.items[${index}]`)
    assert(Number.isInteger(entry.timelineSequence) && entry.timelineSequence > previous, `${label} must be ordered by ascending timelineSequence`)
    previous = entry.timelineSequence
    assert(typeof entry.eventType === 'string' && typeof entry.displaySummary === 'string', `${label} event fields are missing`)
    assert(!('nodeId' in entry) && !('subjectId' in entry) && !('path' in entry), `${label} leaks worker-private data`)
  }
  assert(data.nextAfterSequence === null || (Number.isInteger(data.nextAfterSequence) && data.nextAfterSequence >= previous), `${label}.nextAfterSequence is invalid`)
}

function assertDemandReceipt(receipt, label) {
  const data = objectOf(objectOf(receipt, label).data, `${label}.data`)
  hasExactKeys(data, ['intakeId', 'demandId', 'demandVersion', 'state', 'receivedAt', 'displayMessage'], `${label}.data`)
  assert(!('taskId' in data), `${label} must preserve DemandIntakeReceiptV1 without taskId`)
}

function main() {
  hasExactKeys(fixture, ['fixtureVersion', 'classification', 'usage', 'errorEnvelope', 'routes', 'fixtureBinding', 'h1', 'c3'], 'fixture')
  assert(fixture.fixtureVersion === '2', 'fixtureVersion must be 2')
  assert(fixture.classification === 'CONTRACT_ONLY_NOT_REAL_INTEGRATION', 'fixture classification is required')
  assert(!/[A-Za-z]:[\\/]/.test(JSON.stringify(fixture)), 'fixture must not contain local absolute paths')
  assert(!JSON.stringify(fixture).includes('BEGIN PRIVATE KEY'), 'fixture must not contain a private key')

  const allowed = fixture.errorEnvelope.allowedCodes
  assert(Array.isArray(allowed) && allowed.length === ERROR_CODES.size && allowed.every((code) => ERROR_CODES.has(code)), 'fixture error closure drifted from C2')
  assert(JSON.stringify(fixture.errorEnvelope.requiredFields) === JSON.stringify(['code', 'messageKey', 'message', 'traceId']), 'fixture error envelope fields drifted')

  const binding = objectOf(fixture.fixtureBinding, 'fixtureBinding')
  hasExactKeys(binding, ['purpose', 'subjectId', 'nodeId', 'keyId', 'publicKeyPem'], 'fixtureBinding')
  assert(typeof binding.publicKeyPem === 'string' && binding.publicKeyPem.includes('BEGIN PUBLIC KEY'), 'fixture must provide a public verification key')

  const h1 = objectOf(fixture.h1, 'h1')
  assertResultSubmission(h1.resultReady.request, binding, 'h1.resultReady.request')
  assertResultSubmission(h1.resultIdempotencyConflict.conflictingSubmission, binding, 'h1.resultIdempotencyConflict.conflictingSubmission')
  assert(h1.resultReady.request.result.resultId === h1.resultIdempotencyConflict.conflictingSubmission.result.resultId, 'result conflict fixture must share resultId')
  assert(h1.resultReady.request.result.resultSha256 !== h1.resultIdempotencyConflict.conflictingSubmission.result.resultSha256, 'result conflict fixture must change canonical content')
  assertErrorEnvelope(h1.resultIdempotencyConflict.response, 'h1.resultIdempotencyConflict.response')
  assertReceipt(h1.legacyTerminalReceiptRejected.request, binding, 'h1.legacyTerminalReceiptRejected.request')
  assertErrorEnvelope(h1.legacyTerminalReceiptRejected.response, 'h1.legacyTerminalReceiptRejected.response')
  assertTimeline(h1.workerTimeline.response, 'h1.workerTimeline.response')
  assertTimeline(h1.publisherTimelineEmpty.response, 'h1.publisherTimelineEmpty.response')
  assertErrorEnvelope(h1.timelineAuthFailure.response, 'h1.timelineAuthFailure.response')
  assertErrorEnvelope(h1.workerRevoked.response, 'h1.workerRevoked.response')

  const c3 = objectOf(fixture.c3, 'c3')
  const accepted = c3.intakeAccepted
  assertHash(accepted.demandContentSha256, 'c3.intakeAccepted.demandContentSha256')
  assert(accepted.demandContentSha256 === sha256(canonicalDemand(accepted.request)), 'c3 intake canonical digest mismatch')
  assertDemandReceipt(accepted.response, 'c3.intakeAccepted.response')
  const mapping = objectOf(accepted.authoritativeMapping, 'c3.intakeAccepted.authoritativeMapping')
  hasExactKeys(mapping, ['schemaVersion', 'intakeId', 'demandId', 'demandVersion', 'demandContentSha256', 'taskId', 'createdAt'], 'c3.intakeAccepted.authoritativeMapping')
  assert(mapping.schemaVersion === 'xiaogui.demand-task-mapping.v1', 'mapping schema version is invalid')
  assert(mapping.intakeId === accepted.response.data.intakeId && mapping.demandId === accepted.request.demandId && mapping.demandVersion === accepted.request.demandVersion && mapping.demandContentSha256 === accepted.demandContentSha256, 'mapping must bind the unchanged V1 receipt')
  assert(typeof mapping.taskId === 'string' && mapping.taskId.length > 0, 'mapping taskId is required outside the V1 receipt')

  const conflicting = c3.intakeSameKeyDifferentContent
  assert(conflicting.firstRequestRef === 'c3.intakeAccepted.request', 'C3 conflict must be compared to the original two-part key')
  assert(conflicting.conflictingRequest.demandId === accepted.request.demandId && conflicting.conflictingRequest.demandVersion === accepted.request.demandVersion, 'C3 conflict must use the same two-part idempotency key')
  assert(conflicting.conflictingContentSha256 === sha256(canonicalDemand(conflicting.conflictingRequest)), 'C3 conflict digest mismatch')
  assert(conflicting.conflictingContentSha256 !== accepted.demandContentSha256, 'C3 conflict must change content digest, not the idempotency key')
  assertErrorEnvelope(conflicting.response, 'c3.intakeSameKeyDifferentContent.response')
  assertErrorEnvelope(c3.intakeAuthenticationFailure.response, 'c3.intakeAuthenticationFailure.response')

  const projection = c3.projectionWriteAccepted.request
  assert(projection.projection.demandId === projection.demandId && projection.projection.intakeId === projection.intakeId, 'projection update identity mismatch')
  assert(projection.projectionSha256 === sha256(canonicalProjection(projection)), 'projection canonical digest mismatch')
  assertErrorEnvelope(c3.projectionVersionConflict.response, 'c3.projectionVersionConflict.response')
  assert(c3.readOnlyProjection.readOnly === true, 'C3 projection fixture must be read-only')

  console.log('H1-4C/C3 contract fixtures: valid (signature, digest, DTO, error-envelope, idempotency, timeline and projection checks passed)')
}

main()
