import type {
  XiaoguiHubNodePairRequestV1,
  XiaoguiHubNodePairResponseV1,
} from '@shared/xiaogui-hub-task-contract'
import type {
  HubTaskWorkerAssignmentDetailV1,
  HubTaskWorkerAssignmentV1,
  HubTaskWorkerOfferV1,
} from './worker-state'
import type { XiaoguiHubTaskWorkerPortV1 } from './worker-service'

const HUB_TASK_API_PREFIX = '/api/v2/taskhub'
const HUB_ACCOUNT_LOGIN_PATH = '/api/v1/auth/login'
const WORKER_NODE_TOKEN_HEADER = 'x-xiaogui-node-token'

export type HubTaskWorkerHttpErrorCodeV1 =
  | 'AUTHENTICATION_FAILED'
  | 'NODE_REVOKED'
  | 'REQUEST_FAILED'
  | 'RESPONSE_INVALID'

/** Safe transport error: it deliberately contains no response body, URL, or credential data. */
export class HubTaskWorkerHttpErrorV1 extends Error {
  constructor(readonly code: HubTaskWorkerHttpErrorCodeV1) {
    super(code)
  }
}

export interface CreateHttpXiaoguiHubTaskWorkerPortOptionsV1 {
  endpoint: string
  accessToken: string
  node?: { deviceToken: string }
  fetchImpl?: typeof fetch
}

export interface HubTaskWorkerAccountLoginInputV1 {
  endpoint: string
  username: string
  password: string
  fetchImpl?: typeof fetch
}

export interface HubTaskWorkerAccountSessionV1 {
  endpoint: string
  accessToken: string
}

/**
 * Exchanges the Hub's own username/password session without returning the
 * JWT to a Renderer. It intentionally uses the v1 auth route, whereas all
 * node-bound task operations use the v2 TaskHub worker routes.
 */
export async function loginHubTaskWorkerAccountV1(
  input: HubTaskWorkerAccountLoginInputV1,
): Promise<HubTaskWorkerAccountSessionV1> {
  const endpoint = normalizeEndpoint(input.endpoint)
  const username = requireText(input.username)
  const password = requireText(input.password)
  if (username.length > 64 || password.length < 8 || password.length > 256) {
    throw new HubTaskWorkerHttpErrorV1('REQUEST_FAILED')
  }
  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${endpoint}${HUB_ACCOUNT_LOGIN_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  } catch {
    throw new HubTaskWorkerHttpErrorV1('REQUEST_FAILED')
  }
  if (!response.ok) {
    if (response.status === 401) throw new HubTaskWorkerHttpErrorV1('AUTHENTICATION_FAILED')
    throw new HubTaskWorkerHttpErrorV1('REQUEST_FAILED')
  }
  try {
    const payload = await response.json()
    if (!isRecord(payload) || !isRecord(payload.data) || !isNonemptyString(payload.data.token)) {
      throw new Error('invalid login response')
    }
    return { endpoint, accessToken: payload.data.token }
  } catch {
    throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
  }
}

export function createHttpXiaoguiHubTaskWorkerPortV1(
  options: CreateHttpXiaoguiHubTaskWorkerPortOptionsV1,
): XiaoguiHubTaskWorkerPortV1 {
  return new HttpXiaoguiHubTaskWorkerPortV1(options)
}

class HttpXiaoguiHubTaskWorkerPortV1 implements XiaoguiHubTaskWorkerPortV1 {
  private readonly endpoint: string
  private readonly accessToken: string
  private readonly nodeToken: string | null
  private readonly fetchImpl: typeof fetch

  constructor(options: CreateHttpXiaoguiHubTaskWorkerPortOptionsV1) {
    this.endpoint = normalizeEndpoint(options.endpoint)
    this.accessToken = requireText(options.accessToken)
    this.nodeToken = options.node ? requireText(options.node.deviceToken) : null
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async pairOrReplaceNode(input: XiaoguiHubNodePairRequestV1): Promise<XiaoguiHubNodePairResponseV1> {
    const payload = await this.request('/nodes/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationIdDigest: input.installationIdDigest }),
    }, false)
    return parsePairResponse(payload)
  }

  async pollAssignments(cursor: string | null): Promise<{ cursor: string | null; assignments: readonly HubTaskWorkerAssignmentV1[] }> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const payload = await this.request(`/worker/assignments${query}`, { method: 'GET' }, true)
    return parseSnapshot(payload)
  }

  async downloadAssignment(assignmentId: string): Promise<HubTaskWorkerAssignmentDetailV1> {
    const payload = await this.request(`/worker/assignments/${encodeURIComponent(requiredOpaqueId(assignmentId))}`, { method: 'GET' }, true)
    return parseDetail(payload)
  }

  async submitDecision(
    assignmentId: string,
    decision: 'ACCEPT' | 'REJECT',
  ): Promise<HubTaskWorkerAssignmentDetailV1> {
    const payload = await this.request(`/worker/assignments/${encodeURIComponent(requiredOpaqueId(assignmentId))}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    }, true)
    return parseDetail(payload)
  }

  async returnAssignment(assignmentId: string): Promise<HubTaskWorkerAssignmentDetailV1> {
    const payload = await this.request(`/worker/assignments/${encodeURIComponent(requiredOpaqueId(assignmentId))}/return`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, true)
    return parseDetail(payload)
  }

  async claimOffer(taskId: string): Promise<HubTaskWorkerAssignmentDetailV1> {
    const payload = await this.request(`/worker/offers/${encodeURIComponent(requiredOpaqueId(taskId))}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, true)
    return parseDetail(payload)
  }

  private async request(path: string, init: RequestInit, needsNodeToken: boolean): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.accessToken}`,
      accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    }
    if (needsNodeToken) {
      if (!this.nodeToken) throw new HubTaskWorkerHttpErrorV1('NODE_REVOKED')
      headers[WORKER_NODE_TOKEN_HEADER] = this.nodeToken
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.endpoint}${HUB_TASK_API_PREFIX}${path}`, { ...init, headers })
    } catch {
      throw new HubTaskWorkerHttpErrorV1('REQUEST_FAILED')
    }
    if (!response.ok) {
      if (response.status === 401) throw new HubTaskWorkerHttpErrorV1('AUTHENTICATION_FAILED')
      if (response.status === 403 || response.status === 409) throw new HubTaskWorkerHttpErrorV1('NODE_REVOKED')
      throw new HubTaskWorkerHttpErrorV1('REQUEST_FAILED')
    }
    try {
      const payload = await response.json()
      if (!isRecord(payload) || !isRecord(payload.data)) throw new Error('invalid response')
      return payload.data
    } catch {
      throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
    }
  }
}

function parsePairResponse(value: unknown): XiaoguiHubNodePairResponseV1 {
  const source = record(value)
  const binding = record(source.binding)
  if (
    !isOpaqueId(binding.nodeId) ||
    !isOpaqueId(binding.subjectId) ||
    !isSha256(binding.installationIdDigest) ||
    !isOpaqueId(binding.keyId) ||
    typeof binding.publicKeyPem !== 'string' ||
    !isSha256(binding.publicKeyDigest) ||
    binding.state !== 'ACTIVE' ||
    !isTimestamp(binding.pairedAt) ||
    binding.revokedAt !== null ||
    !isTimestamp(binding.lastSeenAt) ||
    !isNonemptyString(source.deviceToken) ||
    !isNonemptyString(source.privateKeyPem)
  ) {
    throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
  }
  return {
    binding: {
      nodeId: binding.nodeId,
      subjectId: binding.subjectId,
      installationIdDigest: binding.installationIdDigest,
      keyId: binding.keyId,
      publicKeyPem: binding.publicKeyPem,
      publicKeyDigest: binding.publicKeyDigest,
      state: 'ACTIVE',
      pairedAt: binding.pairedAt,
      revokedAt: null,
      lastSeenAt: binding.lastSeenAt,
    },
    deviceToken: source.deviceToken,
    privateKeyPem: source.privateKeyPem,
  }
}

function parseSnapshot(value: unknown): { cursor: string | null; assignments: readonly HubTaskWorkerAssignmentV1[] } {
  const source = record(value)
  if (source.schemaVersion !== 'xiaogui.hub.worker-assignment-snapshot.v1' || !Array.isArray(source.assignments)) {
    throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
  }
  const cursor = source.cursor === null ? null : typeof source.cursor === 'string' ? source.cursor : invalidResponse()
  return { cursor, assignments: source.assignments.map(parseAssignment) }
}

function parseDetail(value: unknown): HubTaskWorkerAssignmentDetailV1 {
  const source = record(value)
  if (source.schemaVersion !== 'xiaogui.hub.worker-assignment-detail.v1') {
    throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
  }
  const assignment = parseAssignment(source.assignment)
  const offer = parseOffer(source.offer)
  if (assignment.taskId !== offer.taskId) throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
  return { assignment, offer }
}

function parseAssignment(value: unknown): HubTaskWorkerAssignmentV1 {
  const source = record(value)
  if (
    source.schemaVersion !== 'xiaogui.hub.worker-assignment.v1' ||
    !isOpaqueId(source.assignmentId) ||
    !isOpaqueId(source.taskId) ||
    !isOneOf(source.decisionState, ['PENDING', 'ACCEPTED', 'REJECTED', 'RETURNED']) ||
    !isOneOf(source.deliveryState, ['QUEUED', 'NODE_STORED', 'OPENED']) ||
    !isOneOf(source.executionState, ['NOT_STARTED', 'RUNNING', 'RESULT_READY', 'COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN']) ||
    !isTimestamp(source.createdAt) ||
    !isTimestamp(source.updatedAt)
  ) {
    throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
  }
  return {
    assignmentId: source.assignmentId,
    taskId: source.taskId,
    decisionState: source.decisionState,
    deliveryState: source.deliveryState,
    executionState: source.executionState,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

function parseOffer(value: unknown): HubTaskWorkerOfferV1 {
  const source = record(value)
  if (
    source.schemaVersion !== 'xiaogui.hub.worker-offer.v1' ||
    !isOpaqueId(source.taskId) ||
    !isOneOf(source.mode, ['DIRECT', 'POOL']) ||
    !isNonemptyString(source.title) ||
    !isNonemptyString(source.taskContent) ||
    !isStringArray(source.constraints) ||
    !isStringArray(source.acceptanceRequirements) ||
    !isStringArray(source.attachmentRefs) ||
    !isSha256(source.packageSha256)
  ) {
    throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
  }
  return {
    taskId: source.taskId,
    mode: source.mode,
    title: source.title,
    taskContent: source.taskContent,
    constraints: source.constraints,
    acceptanceRequirements: source.acceptanceRequirements,
    attachmentRefs: source.attachmentRefs,
    packageSha256: source.packageSha256,
  }
}

function normalizeEndpoint(value: string): string {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid endpoint')
    }
    return url.origin
  } catch {
    throw new HubTaskWorkerHttpErrorV1('REQUEST_FAILED')
  }
}

function requireText(value: string): string {
  const text = value.trim()
  if (!text) throw new HubTaskWorkerHttpErrorV1('REQUEST_FAILED')
  return text
}

function requiredOpaqueId(value: string): string {
  if (!isOpaqueId(value)) throw new HubTaskWorkerHttpErrorV1('REQUEST_FAILED')
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
  return value
}

function invalidResponse(): never {
  throw new HubTaskWorkerHttpErrorV1('RESPONSE_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}
