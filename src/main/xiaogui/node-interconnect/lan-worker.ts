import { createHash } from 'node:crypto'

import {
  validateXiaoguiNodePublicDtoV1,
  type XiaoguiAssignmentEnvelopeV1,
  type XiaoguiNodeCapabilityManifestV1,
} from '@shared/xiaogui-node-contract'
import {
  isLanNodeIdV1 as isNodeId,
  isLanRecordV1 as isRecord,
  parseXiaoguiLanEnvelopeResponseV1 as parseEnvelopeResponse,
  parseXiaoguiLanReconcileResponseV1 as parseReconcileResponse,
  parseXiaoguiLanSimpleResponseV1 as parseSimpleResponse,
  type XiaoguiLanFailureResponseV1,
  type XiaoguiLanReconcileResponseV1,
  type XiaoguiLanSimpleResponseV1,
} from './lan-contract-shapes'
import {
  createInMemoryWorkerAssignmentLedgerV1,
  createXiaoguiLanWorkerLedgerForUserDataV1,
  type WorkerAssignmentLedgerV1,
} from './worker-assignment-ledger'
import { xiaoguiTaskIdentityDigestV1 } from './hub-assignment-store'
import { validateXiaoguiLanHubOriginV1 } from './lan-network-policy'

export type XiaoguiLanWorkerPollResultV1 =
  | { status: 'NO_WORK' }
  | { status: 'WAITING_LOCAL_APPROVAL'; assignmentId: string }
  | { status: 'COMPLETED'; assignmentId: string; resultDigest: string }
  | { status: 'FAILED'; assignmentId: string; reasonCode: string }
  | { status: 'OUTCOME_UNKNOWN'; assignmentId: string; reasonCode: string }

export interface XiaoguiLanWorkerV1 {
  register(): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  heartbeat(): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  reconcile(): Promise<
    | { ok: true; value: XiaoguiLanWorkerPollResultV1 | null }
    | { ok: false; reasonCode: string }
  >
  pollOnce(): Promise<{ ok: true; value: XiaoguiLanWorkerPollResultV1 } | { ok: false; reasonCode: string }>
}

type LanWorkerFailureV1 = XiaoguiLanFailureResponseV1
type LanWorkerSimpleResponseV1 = XiaoguiLanSimpleResponseV1
type LanWorkerClaimResponseV1 = { ok: true; envelope: XiaoguiAssignmentEnvelopeV1 } | LanWorkerFailureV1
type LanWorkerReconcileResponseV1 = XiaoguiLanReconcileResponseV1
type LanWorkerSimpleRouteV1 =
  | '/register'
  | '/heartbeat'
  | '/approve-local'
  | '/mark-running'
  | '/complete'
  | '/fail'
  | '/outcome-unknown'
type LanWorkerRouteV1 = LanWorkerSimpleRouteV1 | '/claim' | '/reconcile'

export function createXiaoguiLanWorkerV1(options: {
  origin: string
  nodeToken: string
  manifest: XiaoguiNodeCapabilityManifestV1
  approveLocal: (envelope: XiaoguiAssignmentEnvelopeV1) => Promise<boolean>
  executeLocal: (envelope: XiaoguiAssignmentEnvelopeV1) => Promise<
    | { status: 'SUCCEEDED'; resultDigest: string }
    | { status: 'FAILED'; reasonCode: string }
  >
  ledger?: WorkerAssignmentLedgerV1
  /** Product activation must pass Electron app.getPath('userData'); tests may inject an in-memory ledger. */
  userDataDir?: string
}): XiaoguiLanWorkerV1 {
  const validatedOrigin = validateXiaoguiLanHubOriginV1(options.origin)
  if (!validatedOrigin.ok) throw new Error(validatedOrigin.reasonCode)
  const origin = validatedOrigin.origin
  let pending: XiaoguiAssignmentEnvelopeV1 | undefined
  const ledger = options.ledger
    ?? (options.userDataDir
      ? createXiaoguiLanWorkerLedgerForUserDataV1(options.userDataDir)
      : createInMemoryWorkerAssignmentLedgerV1())
  const nodeId = String(options.manifest.identity.nodeId)

  return {
    register: () => post(origin, '/register', { manifest: options.manifest }, options.nodeToken),
    heartbeat: () => post(origin, '/heartbeat', { nodeId, health: options.manifest.health }, options.nodeToken),
    async reconcile() {
      try {
        const replay = await reconcileActiveLedger(origin, options.nodeToken, nodeId, ledger)
        return replay ?? { ok: true, value: null }
      } catch {
        return { ok: false, reasonCode: 'LAN_WORKER_LEDGER_FAILED' }
      }
    },
    async pollOnce() {
      try {
      const heartbeat = await this.heartbeat()
      if (!heartbeat.ok) return heartbeat
      if (!pending) {
        const replay = await this.reconcile()
        if (!replay.ok) return replay
        if (replay.value) return { ok: true, value: replay.value }
        const claim = await post(origin, '/claim', { nodeId }, options.nodeToken)
        if (!claim.ok) {
          return claim.reasonCode === 'NO_CLAIMABLE_ASSIGNMENT'
            ? { ok: true, value: { status: 'NO_WORK' } }
            : claim
        }
        pending = claim.envelope
      }
      const envelope = pending
      const taskIdentityDigest = xiaoguiTaskIdentityDigestV1(envelope.taskId)
      const existingTask = await ledger.getByTaskIdentity(taskIdentityDigest)
      if (existingTask && existingTask.assignmentId !== envelope.assignmentId) {
        const reasonCode = existingTask.status === 'SETTLED' || existingTask.status === 'OUTCOME_UNKNOWN'
          ? 'WORKER_TASK_IDENTITY_ALREADY_CLOSED'
          : 'WORKER_TASK_IDENTITY_ALREADY_ACTIVE'
        await post(
          origin,
          '/outcome-unknown',
          { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId, reasonCode },
          options.nodeToken,
        )
        await ledger.upsert({
          assignmentId: envelope.assignmentId,
          taskIdentityDigest,
          leaseId: envelope.leaseId,
          attemptId: attemptId(envelope),
          status: 'OUTCOME_UNKNOWN',
          summaryDigest: assignmentSummaryDigest(envelope),
          updatedAt: new Date().toISOString(),
        })
        pending = undefined
        return { ok: true, value: { status: 'OUTCOME_UNKNOWN', assignmentId: envelope.assignmentId, reasonCode } }
      }
      const existing = await ledger.get(envelope.assignmentId)
      if (existing?.status === 'SETTLED' || existing?.status === 'OUTCOME_UNKNOWN') {
        pending = undefined
        return { ok: true, value: { status: 'OUTCOME_UNKNOWN', assignmentId: envelope.assignmentId, reasonCode: 'WORKER_LEDGER_ALREADY_CLOSED' } }
      }
      let locallyApproved: boolean
      try {
        locallyApproved = await options.approveLocal(envelope)
      } catch {
        await post(
          origin,
          '/outcome-unknown',
          {
            nodeId,
            assignmentId: envelope.assignmentId,
            leaseId: envelope.leaseId,
            reasonCode: 'LAN_LOCAL_APPROVAL_FAILED',
          },
          options.nodeToken,
        )
        pending = undefined
        return { ok: false, reasonCode: 'LAN_LOCAL_APPROVAL_FAILED' }
      }
      if (!locallyApproved) {
        await ledger.upsert({
          assignmentId: envelope.assignmentId,
          taskIdentityDigest,
          leaseId: envelope.leaseId,
          attemptId: attemptId(envelope),
          status: 'AWAITING_LOCAL_APPROVAL',
          summaryDigest: assignmentSummaryDigest(envelope),
          updatedAt: new Date().toISOString(),
        })
        return { ok: true, value: { status: 'WAITING_LOCAL_APPROVAL', assignmentId: envelope.assignmentId } }
      }
      const approved = await post(origin, '/approve-local', { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId }, options.nodeToken)
      if (!approved.ok) return approved
      const running = await post(origin, '/mark-running', { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId }, options.nodeToken)
      if (!running.ok) return running
      await ledger.upsert({
        assignmentId: envelope.assignmentId,
        taskIdentityDigest,
        leaseId: envelope.leaseId,
        attemptId: attemptId(envelope),
        status: 'RUNNING',
        summaryDigest: assignmentSummaryDigest(envelope),
        updatedAt: new Date().toISOString(),
      })

      let local: { status: 'SUCCEEDED'; resultDigest: string } | { status: 'FAILED'; reasonCode: string }
      try { local = await options.executeLocal(envelope) } catch { local = { status: 'FAILED', reasonCode: 'LOCAL_EXECUTION_FAILED' } }
      pending = undefined
      if (local.status === 'FAILED') {
        const settled = await post(origin, '/fail', { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId, reasonCode: local.reasonCode }, options.nodeToken)
        await ledger.upsert({
          assignmentId: envelope.assignmentId,
          taskIdentityDigest,
          leaseId: envelope.leaseId,
          attemptId: attemptId(envelope),
          status: settled.ok ? 'SETTLED' : 'OUTCOME_UNKNOWN',
          summaryDigest: assignmentSummaryDigest(envelope),
          updatedAt: new Date().toISOString(),
        })
        return settled.ok
          ? { ok: true, value: { status: 'FAILED', assignmentId: envelope.assignmentId, reasonCode: local.reasonCode } }
          : { ok: true, value: { status: 'OUTCOME_UNKNOWN', assignmentId: envelope.assignmentId, reasonCode: 'LAN_SETTLEMENT_UNKNOWN' } }
      }
      const settled = await post(origin, '/complete', { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId, resultDigest: local.resultDigest }, options.nodeToken)
      await ledger.upsert({
        assignmentId: envelope.assignmentId,
        taskIdentityDigest,
        leaseId: envelope.leaseId,
        attemptId: attemptId(envelope),
        status: settled.ok ? 'SETTLED' : 'OUTCOME_UNKNOWN',
        summaryDigest: assignmentSummaryDigest(envelope),
        receiptDigest: local.resultDigest,
        updatedAt: new Date().toISOString(),
      })
      return settled.ok
        ? { ok: true, value: { status: 'COMPLETED', assignmentId: envelope.assignmentId, resultDigest: local.resultDigest } }
        : { ok: true, value: { status: 'OUTCOME_UNKNOWN', assignmentId: envelope.assignmentId, reasonCode: 'LAN_SETTLEMENT_UNKNOWN' } }
      } catch {
        return { ok: false, reasonCode: 'LAN_WORKER_LEDGER_FAILED' }
      }
    },
  }
}

async function reconcileActiveLedger(
  origin: string,
  nodeToken: string,
  nodeId: string,
  ledger: WorkerAssignmentLedgerV1,
): Promise<{ ok: true; value: XiaoguiLanWorkerPollResultV1 } | { ok: false; reasonCode: string } | null> {
  for (const record of await ledger.listActive()) {
    const reconciled = await post(origin, '/reconcile', { nodeId, assignmentId: record.assignmentId }, nodeToken)
    if (!reconciled.ok) {
      await ledger.upsert({ ...record, status: 'OUTCOME_UNKNOWN', updatedAt: new Date().toISOString() })
      return { ok: true, value: { status: 'OUTCOME_UNKNOWN', assignmentId: record.assignmentId, reasonCode: 'LAN_RECONCILE_UNAVAILABLE' } }
    }
    if (reconciled.status === 'COMPLETED') {
      await ledger.upsert({ ...record, status: 'SETTLED', receiptDigest: reconciled.resultDigest, updatedAt: new Date().toISOString() })
      continue
    }
    if (reconciled.status === 'FAILED') {
      await ledger.upsert({ ...record, status: 'SETTLED', updatedAt: new Date().toISOString() })
      continue
    }
    if (reconciled.status === 'OUTCOME_UNKNOWN' || reconciled.status === 'LEASE_EXPIRED') {
      await ledger.upsert({ ...record, status: 'OUTCOME_UNKNOWN', updatedAt: new Date().toISOString() })
      continue
    }
    const reasonCode = record.status === 'RUNNING'
      ? 'WORKER_RESTARTED_DURING_RUNNING'
      : 'WORKER_RESTARTED_DURING_APPROVAL'
    const marked = await post(
      origin,
      '/outcome-unknown',
      { nodeId, assignmentId: record.assignmentId, leaseId: record.leaseId, reasonCode },
      nodeToken,
    )
    await ledger.upsert({ ...record, status: 'OUTCOME_UNKNOWN', updatedAt: new Date().toISOString() })
    return marked.ok
      ? { ok: true, value: { status: 'OUTCOME_UNKNOWN', assignmentId: record.assignmentId, reasonCode } }
      : { ok: true, value: { status: 'OUTCOME_UNKNOWN', assignmentId: record.assignmentId, reasonCode: 'LAN_OUTCOME_UNKNOWN_MARK_FAILED' } }
  }
  return null
}

function attemptId(envelope: XiaoguiAssignmentEnvelopeV1): string {
  return `${envelope.assignmentId}.${envelope.leaseId}`
}

function assignmentSummaryDigest(envelope: XiaoguiAssignmentEnvelopeV1): string {
  return `sha256:${createHash('sha256').update([
    envelope.assignmentId,
    envelope.taskId,
    envelope.targetNodeId,
    envelope.leaseId,
    envelope.payloadRef.digest,
  ].join('|')).digest('hex')}`
}

function post(origin: string, route: '/claim', body: unknown, token: string): Promise<LanWorkerClaimResponseV1>
function post(origin: string, route: '/reconcile', body: unknown, token: string): Promise<LanWorkerReconcileResponseV1>
function post(origin: string, route: LanWorkerSimpleRouteV1, body: unknown, token: string): Promise<LanWorkerSimpleResponseV1>
async function post(
  origin: string,
  route: LanWorkerRouteV1,
  body: unknown,
  token: string,
): Promise<LanWorkerSimpleResponseV1 | LanWorkerClaimResponseV1 | LanWorkerReconcileResponseV1> {
  if (!validateXiaoguiNodePublicDtoV1(body).ok) return { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' }
  try {
    const response = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const result: unknown = await response.json()
    if (!validateXiaoguiNodePublicDtoV1(result).ok) {
      return { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' }
    }
    const expectedNodeId = route === '/claim' && isRecord(body) && isNodeId(body.nodeId)
      ? body.nodeId
      : undefined
    return parseLanWorkerResponse(route, result, expectedNodeId)
  } catch {
    return { ok: false, reasonCode: 'LAN_WORKER_TRANSPORT_FAILED' }
  }
}

function parseLanWorkerResponse(
  route: LanWorkerRouteV1,
  value: unknown,
  expectedNodeId?: string,
): LanWorkerSimpleResponseV1 | LanWorkerClaimResponseV1 | LanWorkerReconcileResponseV1 {
  if (route === '/claim') {
    return parseEnvelopeResponse(value, { expectedNodeId }) ?? invalidResponse()
  }
  if (route === '/reconcile') {
    return parseReconcileResponse(value) ?? invalidResponse()
  }
  return parseSimpleResponse(value) ?? invalidResponse()
}

function invalidResponse(): LanWorkerFailureV1 {
  return { ok: false, reasonCode: 'LAN_WORKER_RESPONSE_INVALID' }
}
