import { createHash } from 'node:crypto'

import {
  validateXiaoguiNodePublicDtoV1,
  type XiaoguiAssignmentEnvelopeV1,
  type XiaoguiNodeCapabilityManifestV1,
} from '@shared/xiaogui-node-contract'
import {
  createInMemoryWorkerAssignmentLedgerV1,
  createXiaoguiLanWorkerLedgerForUserDataV1,
  type WorkerAssignmentLedgerV1,
} from './worker-assignment-ledger'

export type XiaoguiLanWorkerPollResultV1 =
  | { status: 'NO_WORK' }
  | { status: 'WAITING_LOCAL_APPROVAL'; assignmentId: string }
  | { status: 'COMPLETED'; assignmentId: string; resultDigest: string }
  | { status: 'FAILED'; assignmentId: string; reasonCode: string }
  | { status: 'OUTCOME_UNKNOWN'; assignmentId: string; reasonCode: string }

export interface XiaoguiLanWorkerV1 {
  register(): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  heartbeat(): Promise<{ ok: true } | { ok: false; reasonCode: string }>
  pollOnce(): Promise<{ ok: true; value: XiaoguiLanWorkerPollResultV1 } | { ok: false; reasonCode: string }>
}

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
  let pending: XiaoguiAssignmentEnvelopeV1 | undefined
  const ledger = options.ledger
    ?? (options.userDataDir
      ? createXiaoguiLanWorkerLedgerForUserDataV1(options.userDataDir)
      : createInMemoryWorkerAssignmentLedgerV1())
  const nodeId = String(options.manifest.identity.nodeId)

  return {
    register: () => post(options.origin, '/register', { manifest: options.manifest }, options.nodeToken),
    heartbeat: () => post(options.origin, '/heartbeat', { nodeId, health: options.manifest.health }, options.nodeToken),
    async pollOnce() {
      const heartbeat = await this.heartbeat()
      if (!heartbeat.ok) return heartbeat
      if (!pending) {
        const replay = await reconcileActiveLedger(options.origin, options.nodeToken, nodeId, ledger)
        if (replay) return replay
        const claim = await post<{ ok: true; envelope: XiaoguiAssignmentEnvelopeV1 } | { ok: false; reasonCode: string }>(options.origin, '/claim', { nodeId }, options.nodeToken)
        if (!claim.ok) {
          return claim.reasonCode === 'NO_CLAIMABLE_ASSIGNMENT'
            ? { ok: true, value: { status: 'NO_WORK' } }
            : claim
        }
        pending = claim.envelope
      }
      const envelope = pending
      const existing = await ledger.get(envelope.assignmentId)
      if (existing?.status === 'SETTLED' || existing?.status === 'OUTCOME_UNKNOWN') {
        pending = undefined
        return { ok: true, value: { status: 'OUTCOME_UNKNOWN', assignmentId: envelope.assignmentId, reasonCode: 'WORKER_LEDGER_ALREADY_CLOSED' } }
      }
      if (!await options.approveLocal(envelope)) {
        await ledger.upsert({
          assignmentId: envelope.assignmentId,
          leaseId: envelope.leaseId,
          attemptId: attemptId(envelope),
          status: 'AWAITING_LOCAL_APPROVAL',
          summaryDigest: assignmentSummaryDigest(envelope),
          updatedAt: new Date().toISOString(),
        })
        return { ok: true, value: { status: 'WAITING_LOCAL_APPROVAL', assignmentId: envelope.assignmentId } }
      }
      const approved = await post(options.origin, '/approve-local', { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId }, options.nodeToken)
      if (!approved.ok) return approved
      const running = await post(options.origin, '/mark-running', { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId }, options.nodeToken)
      if (!running.ok) return running
      await ledger.upsert({
        assignmentId: envelope.assignmentId,
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
        const settled = await post(options.origin, '/fail', { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId, reasonCode: local.reasonCode }, options.nodeToken)
        await ledger.upsert({
          assignmentId: envelope.assignmentId,
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
      const settled = await post(options.origin, '/complete', { nodeId, assignmentId: envelope.assignmentId, leaseId: envelope.leaseId, resultDigest: local.resultDigest }, options.nodeToken)
      await ledger.upsert({
        assignmentId: envelope.assignmentId,
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
    const reconciled = await post<
      | { ok: true; status: XiaoguiAssignmentEnvelopeV1['status']; resultDigest?: string; reasonCode?: string }
      | { ok: false; reasonCode: string }
    >(origin, '/reconcile', { nodeId, assignmentId: record.assignmentId }, nodeToken)
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

async function post<T = { ok: true } | { ok: false; reasonCode: string }>(origin: string, route: string, body: unknown, token: string): Promise<T> {
  if (!validateXiaoguiNodePublicDtoV1(body).ok) return { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' } as T
  try {
    const response = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const result = await response.json() as T
    return validateXiaoguiNodePublicDtoV1(result).ok ? result : { ok: false, reasonCode: 'NODE_PUBLIC_DTO_LEAK' } as T
  } catch {
    return { ok: false, reasonCode: 'LAN_WORKER_TRANSPORT_FAILED' } as T
  }
}
