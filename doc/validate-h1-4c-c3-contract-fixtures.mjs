import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const contractPath = fileURLToPath(new URL('./H1-4C-C3-CONTRACT-V1.openapi.json', import.meta.url))
const fixturePath = fileURLToPath(new URL('./H1-4C-C3-CONTRACT-FIXTURES.json', import.meta.url))
const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

const C2_ERROR_CODES = [
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
]

const SECURITY_BY_PROFILE = {
  WORKER_USER_AND_NODE: [{ workerUserJwt: [], xiaoguiNodeToken: [] }],
  PUBLISHER_USER: [{ publisherUserJwt: [] }],
  C3_OUTBOX_INTEGRATION: [{ c3OutboxIntegrationToken: [] }],
  TASKHUB_PROJECTION_INTEGRATION: [{ taskHubProjectionIntegrationToken: [] }],
  COMMUNITY_USER_SESSION: [{ communityUserSession: [] }],
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value, label) {
  assert(isRecord(value), `${label} must be an object`)
  return value
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sha256(text) {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`
}

function resolveLocalReference(root, reference, label) {
  assert(typeof reference === 'string' && reference.startsWith('#/'), `${label} must be a local #/ reference`)
  let current = root
  for (const segment of reference.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    assert(isRecord(current) && Object.prototype.hasOwnProperty.call(current, key), `${label} cannot resolve ${reference}`)
    current = current[key]
  }
  return current
}

function resolveContractValue(value, label) {
  let current = value
  const visited = new Set()
  while (isRecord(current) && typeof current.$ref === 'string') {
    assert(!visited.has(current.$ref), `${label} has a circular contract reference`)
    visited.add(current.$ref)
    current = resolveLocalReference(contract, current.$ref, label)
  }
  return current
}

function schemaByName(name) {
  const schemas = record(record(contract.components, 'contract.components').schemas, 'contract.components.schemas')
  assert(Object.prototype.hasOwnProperty.call(schemas, name), `unknown contract schema ${name}`)
  return schemas[name]
}

function valueMatchesType(value, type) {
  if (type === 'null') return value === null
  if (type === 'object') return isRecord(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return false
}

/**
 * This is intentionally a narrow JSON-Schema 2020-12 evaluator for the
 * keywords actually used by the candidate OpenAPI source. It validates the
 * fixture through the same OpenAPI schema seams that later adapters consume.
 */
function validateSchema(value, schemaInput, label) {
  const schema = typeof schemaInput === 'string'
    ? resolveContractValue(schemaByName(schemaInput), label)
    : resolveContractValue(schemaInput, label)
  record(schema, `${label}.schema`)

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    assert(sameJson(value, schema.const), `${label} must equal its contract const`)
  }
  if (Array.isArray(schema.enum)) {
    assert(schema.enum.some((entry) => sameJson(entry, value)), `${label} is not in its contract enum`)
  }
  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type]
    assert(allowedTypes.some((type) => valueMatchesType(value, type)), `${label} has an invalid contract type`)
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number') assert(value.length >= schema.minLength, `${label} is shorter than contract minimum`)
    if (typeof schema.pattern === 'string') assert(new RegExp(schema.pattern).test(value), `${label} does not match contract pattern`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number') assert(value >= schema.minimum, `${label} is below contract minimum`)
    if (typeof schema.maximum === 'number') assert(value <= schema.maximum, `${label} is above contract maximum`)
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => validateSchema(entry, schema.items, `${label}[${index}]`))
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const field of required) assert(Object.prototype.hasOwnProperty.call(value, field), `${label}.${field} is required`)
    for (const [field, entry] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, field)) {
        validateSchema(entry, properties[field], `${label}.${field}`)
      } else if (schema.additionalProperties === false) {
        throw new Error(`${label}.${field} is not allowed by the strict contract schema`)
      } else if (isRecord(schema.additionalProperties)) {
        validateSchema(entry, schema.additionalProperties, `${label}.${field}`)
      }
    }
  }
}

function expectRejected(label, action) {
  try {
    action()
  } catch {
    return
  }
  throw new Error(`${label} unexpectedly passed validation`)
}

function resolveFixtureReference(reference, label) {
  assert(typeof reference === 'string' && reference.length > 0, `${label} fixture reference is required`)
  let current = fixture
  for (const segment of reference.split('.')) {
    assert(isRecord(current) && Object.prototype.hasOwnProperty.call(current, segment), `${label} cannot resolve fixture reference ${reference}`)
    current = current[segment]
  }
  return current
}

function resolveFixturePayload(container, field, label) {
  if (Object.prototype.hasOwnProperty.call(container, field)) return container[field]
  const referenceField = `${field}Ref`
  assert(Object.prototype.hasOwnProperty.call(container, referenceField), `${label} must contain ${field} or ${referenceField}`)
  return resolveFixtureReference(container[referenceField], `${label}.${referenceField}`)
}

function responseSchemaFor(operation, httpStatus, label) {
  const responses = record(operation.responses, `${label}.responses`)
  const response = resolveContractValue(responses[String(httpStatus)], `${label}.responses.${httpStatus}`)
  assert(isRecord(response), `${label} does not declare HTTP ${httpStatus}`)
  const content = record(response.content, `${label}.response.content`)
  const json = record(content['application/json'], `${label}.response.application/json`)
  assert(json.schema !== undefined, `${label}.response schema is required`)
  return json.schema
}

function requestSchemaFor(operation, label) {
  const body = record(operation.requestBody, `${label}.requestBody`)
  const content = record(body.content, `${label}.requestBody.content`)
  const json = record(content['application/json'], `${label}.requestBody.application/json`)
  assert(json.schema !== undefined, `${label}.request schema is required`)
  return json.schema
}

function allOperations() {
  const found = new Map()
  for (const [path, pathItem] of Object.entries(record(contract.paths, 'contract.paths'))) {
    for (const method of ['get', 'post', 'put']) {
      if (!isRecord(pathItem) || !isRecord(pathItem[method])) continue
      const operation = pathItem[method]
      assert(typeof operation.operationId === 'string' && operation.operationId.length > 0, `${method.toUpperCase()} ${path} needs operationId`)
      assert(!found.has(operation.operationId), `operationId ${operation.operationId} is duplicated`)
      found.set(operation.operationId, { path, method, operation })
    }
  }
  return found
}

const operations = allOperations()

function operationFor(operationId, label) {
  assert(typeof operationId === 'string' && operations.has(operationId), `${label} references an unknown contract operationId`)
  return operations.get(operationId)
}

function querySchemasFor(operation, label) {
  const result = new Map()
  for (const rawParameter of operation.parameters ?? []) {
    const parameter = resolveContractValue(rawParameter, `${label}.parameter`)
    if (parameter.in === 'query') result.set(parameter.name, parameter.schema)
  }
  return result
}

function validateCall(callInput, label) {
  const call = record(callInput, `${label}.call`)
  const { operationId, authProfile, httpStatus } = call
  assert(Number.isInteger(httpStatus), `${label}.call.httpStatus must be an integer`)
  const entry = operationFor(operationId, label)
  const declaredProfile = entry.operation['x-auth-profile']
  assert(typeof declaredProfile === 'string' && Object.prototype.hasOwnProperty.call(SECURITY_BY_PROFILE, declaredProfile), `${label} has no frozen auth profile`)
  assert(sameJson(entry.operation.security, SECURITY_BY_PROFILE[declaredProfile]), `${label} operation security drifted from its auth profile`)
  assert(entry.operation.responses && Object.prototype.hasOwnProperty.call(entry.operation.responses, String(httpStatus)), `${label} HTTP ${httpStatus} is not declared by ${operationId}`)
  if (httpStatus >= 200 && httpStatus < 300) {
    assert(authProfile === declaredProfile, `${label} success call must use the operation's frozen auth profile`)
  } else if (httpStatus === 401) {
    assert(authProfile === 'ANONYMOUS', `${label} 401 fixture must model anonymous or missing credentials`)
  } else {
    assert(authProfile === declaredProfile, `${label} authenticated failure must retain the operation's frozen auth profile`)
  }
  if (call.query !== undefined) {
    const query = record(call.query, `${label}.call.query`)
    const schemas = querySchemasFor(entry.operation, label)
    for (const [name, value] of Object.entries(query)) {
      assert(schemas.has(name), `${label}.call.query.${name} is not declared by the route`)
      validateSchema(value, schemas.get(name), `${label}.call.query.${name}`)
    }
  }
  return entry
}

function validateFixtureCall(caseInput, label) {
  const fixtureCase = record(caseInput, label)
  const entry = validateCall(fixtureCase.call, label)
  let request
  if (entry.operation.requestBody !== undefined) {
    if (Object.prototype.hasOwnProperty.call(fixtureCase, 'invalidRequest')) {
      request = fixtureCase.invalidRequest
      expectRejected(`${label}.invalidRequest`, () => validateSchema(request, requestSchemaFor(entry.operation, label), `${label}.invalidRequest`))
    } else {
      request = resolveFixturePayload(fixtureCase, 'request', label)
      validateSchema(request, requestSchemaFor(entry.operation, label), `${label}.request`)
    }
  } else {
    assert(!Object.prototype.hasOwnProperty.call(fixtureCase, 'request') && !Object.prototype.hasOwnProperty.call(fixtureCase, 'requestRef'), `${label} has a body for a bodyless route`)
  }
  const response = resolveFixturePayload(fixtureCase, 'response', label)
  validateSchema(response, responseSchemaFor(entry.operation, fixtureCase.call.httpStatus, label), `${label}.response`)
  return { entry, request, response }
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
  assert(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value), `${label} must be a lowercase sha256 digest`)
}

function assertError(response, expectedCode, expectedMessageKey, label) {
  validateSchema(response, 'ErrorEnvelopeV1', label)
  const error = response.error
  if (expectedCode) assert(error.code === expectedCode, `${label}.error.code mismatch`)
  if (expectedMessageKey) assert(error.messageKey === expectedMessageKey, `${label}.error.messageKey mismatch`)
}

function expectedKeyId(publicKeyPem) {
  const digest = sha256(publicKeyPem)
  return `ed25519:${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`
}

function assertReceipt(receipt, binding, label, schemaName = 'TaskDeliveryReceiptV1') {
  validateSchema(receipt, schemaName, label)
  assert(receipt.subjectId === binding.subjectId, `${label}.subjectId does not match the fixture binding`)
  assert(receipt.nodeId === binding.nodeId, `${label}.nodeId does not match the fixture binding`)
  assert(receipt.keyId === binding.keyId, `${label}.keyId does not match the fixture binding`)
  assert(receipt.keyId === expectedKeyId(binding.publicKeyPem), `${label}.keyId is not derived from the fixture public key with the existing issue algorithm`)
  const isValid = verify(
    null,
    Buffer.from(canonicalReceipt(receipt), 'utf8'),
    createPublicKey(binding.publicKeyPem),
    Buffer.from(receipt.signature, 'base64'),
  )
  assert(isValid, `${label} Ed25519 signature does not verify`)
}

function assertResultSubmission(fixtureCase, label, expectedExecutionState) {
  const { request, response } = validateFixtureCall(fixtureCase, label)
  const result = request.result
  const receipt = request.receipt
  assert(result.resultSha256 === sha256(canonicalResult(result)), `${label}.resultSha256 does not match the frozen ordered digest`)
  assertReceipt(receipt, fixture.fixtureBinding, `${label}.receipt`, 'TaskResultReceiptV1')
  assert(receipt.assignmentId === result.assignmentId && receipt.taskId === result.taskId, `${label} receipt/result identity mismatch`)
  assert(receipt.eventType === result.outcome, `${label} receipt/result outcome mismatch`)
  assert(receipt.occurredAt === result.occurredAt, `${label} receipt/result occurredAt mismatch`)
  assert(receipt.resultSha256 === result.resultSha256, `${label} receipt/result digest mismatch`)
  assert(response.data.resultId === result.resultId && response.data.eventId === receipt.eventId, `${label} acknowledgement identity mismatch`)
  assert(response.data.executionState === expectedExecutionState, `${label} acknowledgement execution state mismatch`)
  return { request, response }
}

function assertTimelinePage(fixtureCase, label) {
  const { response } = validateFixtureCall(fixtureCase, label)
  const { items, nextAfterSequence } = response.data
  const afterSequence = fixtureCase.call.query.afterSequence
  let previous = afterSequence
  for (const [index, item] of items.entries()) {
    assert(item.timelineSequence > previous, `${label}.items[${index}] must be strictly after its cursor and predecessor`)
    previous = item.timelineSequence
    assert(!('nodeId' in item) && !('subjectId' in item) && !('path' in item) && !('sessionId' in item), `${label}.items[${index}] leaks private worker data`)
    if (['RESULT_READY', 'EXECUTION_FAILED', 'OUTCOME_UNKNOWN'].includes(item.eventType)) {
      assert(item.result !== undefined && item.result.outcome === item.eventType, `${label}.items[${index}] terminal event needs controlled matching result data`)
    } else {
      assert(item.result === undefined, `${label}.items[${index}] non-terminal event must not impersonate a result`)
    }
  }
  if (nextAfterSequence === null) {
    return response
  }
  assert(items.length > 0, `${label} cannot continue an empty page`)
  assert(nextAfterSequence === items.at(-1).timelineSequence, `${label}.nextAfterSequence must equal the final returned sequence, not an arbitrary jump`)
  return response
}

function assertTimelineContinuation(fixtureCase, label) {
  const response = assertTimelinePage(fixtureCase, label)
  const previousPage = resolveFixtureReference(fixtureCase.previousPageRef, `${label}.previousPageRef`)
  const previousResponse = resolveFixturePayload(previousPage, 'response', `${label}.previousPage`)
  const expectedAfterSequence = previousResponse.data.nextAfterSequence
  assert(expectedAfterSequence !== null, `${label} cannot continue after a terminal cursor`)
  assert(fixtureCase.call.query.afterSequence === expectedAfterSequence, `${label} must use the server-issued previous nextAfterSequence exactly`)
  return response
}

function walkFixtureReferences(value, label = 'fixture') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkFixtureReferences(entry, `${label}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, entry] of Object.entries(value)) {
    if (key.endsWith('Ref')) resolveFixtureReference(entry, `${label}.${key}`)
    walkFixtureReferences(entry, `${label}.${key}`)
  }
}

function assertContractStructure() {
  assert(contract.openapi === '3.1.0', 'machine contract must be OpenAPI 3.1')
  assert(contract['x-contract-id'] === fixture.contract.id, 'fixture must reference the exact machine contract id')
  assert(contract.info.version === fixture.contract.version, 'fixture must reference the exact machine contract version')
  assert(fixture.contract.source === 'H1-4C-C3-CONTRACT-V1.openapi.json', 'fixture must identify the machine contract source')
  assert(sameJson(contract['x-closed-error-codes'], C2_ERROR_CODES), 'machine contract error closure drifted from C2')
  assert(sameJson(schemaByName('ErrorCodeV1').enum, C2_ERROR_CODES), 'ErrorCodeV1 must match the machine contract C2 closure')
  assert(sameJson(contract['x-canonicalizations'].taskResultSha256.orderedFields, [
    'schemaVersion', 'resultId', 'assignmentId', 'taskId', 'outcome', 'resultSummary',
    'artifactRefs:[artifactId,mediaType,sha256]', 'verification:[verdict,summary]', 'occurredAt',
  ]), 'TaskResult canonical ordering drifted')
  assert(sameJson(contract['x-canonicalizations'].taskDeliveryReceiptSignature.orderedFields, [
    'schemaVersion', 'eventId', 'assignmentId', 'taskId', 'subjectId', 'nodeId', 'keyId',
    'eventType', 'packageSha256', 'occurredAt', 'sequence', 'resultSha256',
  ]), 'TaskDeliveryReceipt canonical ordering drifted')

  const expectedOperations = [
    ['submitTaskResult', 'post', '/api/v2/taskhub/worker/results', 'WORKER_USER_AND_NODE', [200, 400, 401, 403, 409, 503]],
    ['submitTaskDeliveryReceipt', 'post', '/api/v2/taskhub/worker/receipts', 'WORKER_USER_AND_NODE', [200, 400, 401, 403, 409, 503]],
    ['getWorkerAssignmentTimeline', 'get', '/api/v2/taskhub/worker/assignments/{assignmentId}/timeline', 'WORKER_USER_AND_NODE', [200, 401, 403, 404]],
    ['getPublisherTaskTimeline', 'get', '/api/v2/taskhub/offers/{taskId}/timeline', 'PUBLISHER_USER', [200, 401, 404]],
    ['getPublisherTaskResult', 'get', '/api/v2/taskhub/offers/{taskId}/results/{resultId}', 'PUBLISHER_USER', [200, 401, 404]],
    ['submitDemandIntake', 'post', '/api/v2/taskhub/intakes', 'C3_OUTBOX_INTEGRATION', [200, 400, 401, 403, 409, 503]],
    ['writeDemandTaskHubProjection', 'put', '/api/v2/community/internal/demand-projections/{demandId}', 'TASKHUB_PROJECTION_INTEGRATION', [200, 400, 401, 403, 409, 503]],
    ['readDemandTaskHubProjection', 'get', '/api/v2/demands/{demandId}/taskhub-projection', 'COMMUNITY_USER_SESSION', [200, 401, 404]],
  ]
  for (const [operationId, method, path, authProfile, responseCodes] of expectedOperations) {
    const entry = operationFor(operationId, `contract.${operationId}`)
    assert(entry.method === method && entry.path === path, `${operationId} route/method drifted`)
    assert(entry.operation['x-auth-profile'] === authProfile, `${operationId} auth profile drifted`)
    assert(sameJson(entry.operation.security, SECURITY_BY_PROFILE[authProfile]), `${operationId} security requirements drifted`)
    assert(sameJson(Object.keys(entry.operation.responses).map(Number).sort((a, b) => a - b), responseCodes), `${operationId} response status closure drifted`)
  }

  const resultReceipt = resolveContractValue(schemaByName('TaskResultReceiptV1'), 'TaskResultReceiptV1')
  assert(resultReceipt.required.length === 13 && resultReceipt.required.includes('signature'), 'terminal result receipt must remain a strict 13-field receipt')
  const timelineSummary = resolveContractValue(schemaByName('TimelineResultSummaryV1'), 'TimelineResultSummaryV1')
  for (const field of ['resultId', 'outcome', 'resultSummary', 'artifactRefs', 'verification']) {
    assert(timelineSummary.required.includes(field), `timeline must expose controlled ${field}`)
  }
  const resultView = resolveContractValue(schemaByName('TaskResultViewV1'), 'TaskResultViewV1')
  for (const field of ['resultSummary', 'artifactRefs', 'verification', 'resultSha256']) {
    assert(resultView.required.includes(field), `publisher result detail must expose controlled ${field}`)
  }
  const demand = resolveContractValue(schemaByName('DemandSubmittedV1'), 'DemandSubmittedV1')
  const intakeReceipt = resolveContractValue(schemaByName('DemandIntakeReceiptV1'), 'DemandIntakeReceiptV1')
  assert(demand.additionalProperties === false, 'DemandSubmittedV1 must remain strict')
  assert(intakeReceipt.additionalProperties === false && !Object.prototype.hasOwnProperty.call(intakeReceipt.properties, 'taskId'), 'DemandIntakeReceiptV1 must remain strict and V1-compatible')
  const retry = operationFor('submitDemandIntake', 'submitDemandIntake').operation['x-retry-policy']
  assert(retry.totalAttempts === 5 && sameJson(retry.retryAfterSeconds, [60, 300, 1800, 7200]) && retry.afterFifthFailure === 'DEAD_LETTER', 'C3 retry/dead-letter policy drifted')
}

function assertH1Fixtures() {
  const h1 = record(fixture.h1, 'fixture.h1')
  const ready = assertResultSubmission(h1.resultReady, 'h1.resultReady', 'RESULT_READY')
  const duplicate = validateFixtureCall(h1.resultReadyDuplicate, 'h1.resultReadyDuplicate')
  assert(duplicate.request === ready.request, 'duplicate fixture must reuse the exact original result submission')
  assert(duplicate.response.data.duplicate === true && duplicate.response.data.resultId === ready.request.result.resultId, 'duplicate acknowledgement is incomplete')
  assertResultSubmission(h1.executionFailed, 'h1.executionFailed', 'FAILED')
  assertResultSubmission(h1.outcomeUnknown, 'h1.outcomeUnknown', 'OUTCOME_UNKNOWN')

  const conflict = validateFixtureCall(h1.resultIdempotencyConflict, 'h1.resultIdempotencyConflict')
  const first = resolveFixtureReference(h1.resultIdempotencyConflict.firstSubmissionRef, 'h1.resultIdempotencyConflict.firstSubmissionRef')
  assert(conflict.request.result.resultId === first.result.resultId, 'result idempotency conflict must retain the same resultId')
  assert(conflict.request.result.resultSha256 !== first.result.resultSha256, 'result idempotency conflict must change the canonical result content')
  assertReceipt(conflict.request.receipt, fixture.fixtureBinding, 'h1.resultIdempotencyConflict.receipt', 'TaskResultReceiptV1')
  assertError(conflict.response, 'IDEMPOTENCY_CONFLICT', 'taskhub.result_idempotency_conflict', 'h1.resultIdempotencyConflict.response')

  const legacy = validateFixtureCall(h1.legacyTerminalReceiptRejected, 'h1.legacyTerminalReceiptRejected')
  assertReceipt(legacy.request, fixture.fixtureBinding, 'h1.legacyTerminalReceiptRejected.request')
  assert(['RESULT_READY', 'EXECUTION_FAILED', 'OUTCOME_UNKNOWN'].includes(legacy.request.eventType), 'legacy rejection must use a terminal event')
  assertError(legacy.response, 'VALIDATION_FAILED', 'taskhub.result_envelope_required', 'h1.legacyTerminalReceiptRejected.response')

  assertError(validateFixtureCall(h1.resultAnonymousAuthFailure, 'h1.resultAnonymousAuthFailure').response, 'UNAUTHENTICATED', 'taskhub.worker_unauthenticated', 'h1.resultAnonymousAuthFailure.response')
  assertError(validateFixtureCall(h1.workerRevoked, 'h1.workerRevoked').response, 'FORBIDDEN', 'taskhub.node_revoked', 'h1.workerRevoked.response')

  assertTimelinePage(h1.workerTimeline.firstPage, 'h1.workerTimeline.firstPage')
  assertTimelineContinuation(h1.workerTimeline.secondPage, 'h1.workerTimeline.secondPage')
  assertTimelinePage(h1.publisherTimeline.firstPage, 'h1.publisherTimeline.firstPage')
  assertTimelineContinuation(h1.publisherTimeline.secondPage, 'h1.publisherTimeline.secondPage')
  const detail = validateFixtureCall(h1.publisherResultDetail, 'h1.publisherResultDetail').response.data
  assert(detail.resultSummary === ready.request.result.resultSummary && sameJson(detail.artifactRefs, ready.request.result.artifactRefs) && sameJson(detail.verification, ready.request.result.verification), 'publisher result detail must expose the controlled actual result')
  assertError(validateFixtureCall(h1.publisherTimelineNotFound, 'h1.publisherTimelineNotFound').response, 'NOT_FOUND', 'taskhub.timeline_not_found', 'h1.publisherTimelineNotFound.response')
  assertError(validateFixtureCall(h1.publisherTimelineAnonymous, 'h1.publisherTimelineAnonymous').response, 'UNAUTHENTICATED', 'taskhub.publisher_unauthenticated', 'h1.publisherTimelineAnonymous.response')
}

function assertC3Fixtures() {
  const c3 = record(fixture.c3, 'fixture.c3')
  const accepted = validateFixtureCall(c3.intakeAccepted, 'c3.intakeAccepted')
  assert(accepted.request && accepted.request.demandId, 'accepted intake needs a valid DemandSubmittedV1 request')
  assert(accepted.request && sha256(canonicalDemand(accepted.request)) === c3.intakeAccepted.demandContentSha256, 'accepted intake demand digest mismatch')
  validateSchema(c3.intakeAccepted.authoritativeMapping, 'DemandTaskMappingV1', 'c3.intakeAccepted.authoritativeMapping')
  assert(!Object.prototype.hasOwnProperty.call(accepted.response.data, 'taskId'), 'DemandIntakeReceiptV1 must not gain taskId')
  assert(c3.intakeAccepted.authoritativeMapping.intakeId === accepted.response.data.intakeId && c3.intakeAccepted.authoritativeMapping.taskId.length > 0, 'internal mapping must bind the unchanged V1 receipt to a TaskHub task')

  const sameContent = validateFixtureCall(c3.intakeSameKeySameContent, 'c3.intakeSameKeySameContent')
  assert(sameContent.request === accepted.request && sameContent.response === accepted.response, 'same demand key/content must return the original receipt')
  assert(c3.intakeSameKeySameContent.mappingCreated === false, 'same demand key/content must not create a second mapping')

  const conflict = validateFixtureCall(c3.intakeSameKeyDifferentContent, 'c3.intakeSameKeyDifferentContent')
  const first = resolveFixtureReference(c3.intakeSameKeyDifferentContent.firstRequestRef, 'c3.intakeSameKeyDifferentContent.firstRequestRef')
  assert(conflict.request.demandId === first.demandId && conflict.request.demandVersion === first.demandVersion, 'intake conflict must use exactly demandId + demandVersion')
  assert(sha256(canonicalDemand(conflict.request)) === c3.intakeSameKeyDifferentContent.demandContentSha256, 'intake conflict digest mismatch')
  assert(c3.intakeSameKeyDifferentContent.demandContentSha256 !== c3.intakeAccepted.demandContentSha256, 'intake conflict must alter content, not the key')
  assertError(conflict.response, 'IDEMPOTENCY_CONFLICT', 'taskhub.intake_payload_mismatch', 'c3.intakeSameKeyDifferentContent.response')

  const extra = validateFixtureCall(c3.intakeExtraFieldRejected, 'c3.intakeExtraFieldRejected')
  assertError(extra.response, 'VALIDATION_FAILED', 'taskhub.intake_payload_invalid', 'c3.intakeExtraFieldRejected.response')
  assertError(validateFixtureCall(c3.intakeAuthenticationFailure, 'c3.intakeAuthenticationFailure').response, 'UNAUTHENTICATED', 'c3.integration_unauthenticated', 'c3.intakeAuthenticationFailure.response')

  const retryPolicy = operationFor('submitDemandIntake', 'submitDemandIntake').operation['x-retry-policy']
  const retry = c3.intakeRetryUntilDeadLetter
  assert(resolveFixturePayload(retry, 'request', 'c3.intakeRetryUntilDeadLetter') === accepted.request, 'retry must preserve the original immutable Outbox packet')
  assert(retry.attempts.length === retryPolicy.totalAttempts, 'retry fixture must exercise every permitted attempt')
  for (const [index, attempt] of retry.attempts.entries()) {
    assert(attempt.attempt === index + 1 && attempt.httpStatus === 503, `retry attempt ${index + 1} is malformed`)
    assertError(attempt.response, 'DOWNSTREAM_UNAVAILABLE', 'c3.taskhub_unavailable', `c3.intakeRetryUntilDeadLetter.attempts[${index}].response`)
    if (index < retryPolicy.retryAfterSeconds.length) {
      assert(attempt.nextDelaySeconds === retryPolicy.retryAfterSeconds[index], `retry attempt ${index + 1} delay drifted`)
    } else {
      assert(attempt.nextDelaySeconds === null && attempt.terminalAction === 'DEAD_LETTER', 'final retryable failure must dead-letter without a sixth attempt')
    }
  }

  const projection = validateFixtureCall(c3.projectionWriteAccepted, 'c3.projectionWriteAccepted')
  assert(projection.request.projection.demandId === projection.request.demandId && projection.request.projection.intakeId === projection.request.intakeId, 'projection identity mismatch')
  assert(projection.request.projectionSha256 === sha256(canonicalProjection(projection.request)), 'projection digest mismatch')
  const projectionDuplicate = validateFixtureCall(c3.projectionWriteDuplicate, 'c3.projectionWriteDuplicate')
  assert(projectionDuplicate.request === projection.request && projectionDuplicate.response.data.duplicate === true, 'same projection version and digest must return a duplicate acknowledgement')

  for (const caseName of ['projectionSameVersionConflict', 'projectionLowerVersionConflict']) {
    const current = validateFixtureCall(c3[caseName], `c3.${caseName}`)
    const original = resolveFixtureReference(c3[caseName].firstRequestRef, `c3.${caseName}.firstRequestRef`)
    assert(current.request.demandId === original.demandId && current.request.intakeId === original.intakeId, `${caseName} must target the authoritative mapping`)
    assert(current.request.projectionSha256 === sha256(canonicalProjection(current.request)), `${caseName} projection digest mismatch`)
    assertError(current.response, 'VERSION_CONFLICT', 'c3.projection_version_conflict', `c3.${caseName}.response`)
  }
  assert(c3.projectionSameVersionConflict.request.projection.projectionVersion === projection.request.projection.projectionVersion && c3.projectionSameVersionConflict.request.projectionSha256 !== projection.request.projectionSha256, 'same-version conflict must carry a different digest')
  assert(c3.projectionLowerVersionConflict.request.projection.projectionVersion < projection.request.projection.projectionVersion, 'lower-version conflict must actually be lower')
  assertError(validateFixtureCall(c3.projectionAuthenticationFailure, 'c3.projectionAuthenticationFailure').response, 'UNAUTHENTICATED', 'c3.projection_writer_unauthenticated', 'c3.projectionAuthenticationFailure.response')
  const read = validateFixtureCall(c3.readOnlyProjection, 'c3.readOnlyProjection')
  assert(c3.readOnlyProjection.readOnly === true && sameJson(read.response.data, projection.request.projection), 'community projection read must be a read-only projection snapshot')
}

function assertNegativeFixtures() {
  const negative = record(fixture.negativeCases, 'fixture.negativeCases')
  expectRejected('negativeCases.wrongRouteRejected', () => validateFixtureCall(negative.wrongRouteRejected, 'negativeCases.wrongRouteRejected'))
  expectRejected('negativeCases.anonymousSuccessRejected', () => validateFixtureCall(negative.anonymousSuccessRejected, 'negativeCases.anonymousSuccessRejected'))
  expectRejected('negativeCases.illegalTimelineEventTypeRejected', () => validateSchema(negative.illegalTimelineEventTypeRejected.value, negative.illegalTimelineEventTypeRejected.schema, 'negativeCases.illegalTimelineEventTypeRejected.value'))
  expectRejected('negativeCases.missingResultAckFieldRejected', () => validateSchema(negative.missingResultAckFieldRejected.value, negative.missingResultAckFieldRejected.schema, 'negativeCases.missingResultAckFieldRejected.value'))
  expectRejected('negativeCases.demandUnexpectedFieldRejected', () => validateSchema(resolveFixtureReference(negative.demandUnexpectedFieldRejected.valueRef, 'negativeCases.demandUnexpectedFieldRejected.valueRef'), negative.demandUnexpectedFieldRejected.schema, 'negativeCases.demandUnexpectedFieldRejected.value'))
  expectRejected('negativeCases.brokenFixtureReferenceRejected', () => resolveFixtureReference(negative.brokenFixtureReferenceRejected.reference, 'negativeCases.brokenFixtureReferenceRejected.reference'))
  expectRejected('negativeCases.paginationCursorJumpRejected', () => {
    const previous = resolveFixtureReference(negative.paginationCursorJumpRejected.previousPageRef, 'negativeCases.paginationCursorJumpRejected.previousPageRef')
    const previousResponse = resolveFixturePayload(previous, 'response', 'negativeCases.paginationCursorJumpRejected.previousPage')
    assert(negative.paginationCursorJumpRejected.nextPageCall.query.afterSequence === previousResponse.data.nextAfterSequence, 'pagination continuation skipped the issued cursor')
  })
}

function main() {
  assert(fixture.fixtureVersion === '3', 'fixtureVersion must be 3')
  assert(fixture.classification === 'CONTRACT_ONLY_NOT_REAL_INTEGRATION', 'fixture must remain CONTRACT_ONLY')
  const serialisedFixture = JSON.stringify(fixture)
  assert(!/[A-Za-z]:[\\/]/.test(serialisedFixture), 'fixture must not contain local absolute paths')
  assert(!serialisedFixture.includes('BEGIN PRIVATE KEY'), 'fixture must not contain a private key')
  walkFixtureReferences(fixture)
  assertContractStructure()
  assertH1Fixtures()
  assertC3Fixtures()
  assertNegativeFixtures()
  console.log('H1-4C/C3 machine contract: valid (OpenAPI route/auth/DTO/error checks, Ed25519/keyId, terminal idempotency, pagination, C3 retry/dead-letter and projection checks passed)')
}

main()
