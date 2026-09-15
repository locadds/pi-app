import { createHash } from 'node:crypto'

import { z } from 'zod'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import { registerHandler } from '../../ipc/registry'
import type { HubTaskWorkerInboxEntryV1 } from './worker-state'
import type { HubTaskWorkerServiceV1 } from './worker-service'
import {
  HubTaskWorkerHttpErrorV1,
  loginHubTaskWorkerAccountV1,
  type HubTaskWorkerAccountLoginInputV1,
} from './http-task-worker-port'
import type {
  HubTaskAcceptAndExecuteResultV2,
} from './worker-service'
import type { HubTaskAcceptAndExecutePhaseV2 } from './worker-state'

const ConnectSchema = z.object({
  endpoint: z.string().min(1).max(2_048),
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(256),
}).strict()
const OPAQUE_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const AddressSchema = z.object({
  projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
  sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
}).strict()
const AssignmentSchema = z.object({ assignmentId: OPAQUE_ID }).strict()
const DecisionSchema = AssignmentSchema.extend({ decision: z.enum(['ACCEPT', 'REJECT']) }).strict()
const PlanDraftSchema = AssignmentSchema.extend({ address: AddressSchema }).strict()
/**
 * Renderer may select only the seen assignment, target session and idempotency
 * binding. Main adds the internal contract discriminator before calling the
 * trusted Worker service; no task body, file root, credentials or authority
 * fields cross this seam.
 */
const AcceptAndExecuteSchema = z.object({
  assignmentId: OPAQUE_ID,
  address: AddressSchema,
  observedPackageSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  requestId: OPAQUE_ID,
}).strict()

export interface HubTaskWorkerPublicInboxItemV1 {
  assignmentId: string
  title: string
  taskContent: string
  constraints: readonly string[]
  acceptanceRequirements: readonly string[]
  attachmentCount: number
  mode: 'DIRECT' | 'POOL'
  decisionState: HubTaskWorkerInboxEntryV1['assignment']['decisionState']
  hubDeliveryState: HubTaskWorkerInboxEntryV1['assignment']['deliveryState']
  executionState: HubTaskWorkerInboxEntryV1['assignment']['executionState']
  openedAt: string | null
  receiptPendingSync: boolean
  localPlanDraftCreated: boolean
  /**
   * Minimal private projection needed for a repeatable V2 click. It excludes
   * node identity, target internals, source paths and task body details. Once
   * bound, flow/revision/attempt IDs let the Renderer match exactly one local
   * flow to its legacy gate projection without guessing from another task.
   */
  acceptAndExecuteV2?: {
    state: 'AVAILABLE' | 'BOUND'
    requestId: string
    observedPackageSha256: string
    phase: HubTaskAcceptAndExecutePhaseV2 | null
    projectId?: HubAddressV1['projectId']
    sessionKey?: HubAddressV1['sessionKey']
    flowId?: string
    revisionId?: string
    attemptId?: string
    executionState?: HubTaskAcceptAndExecuteResultV2['executionState']
  }
}

export interface HubTaskWorkerPublicAcceptAndExecuteResultV2 {
  executionState: HubTaskAcceptAndExecuteResultV2['executionState']
  actualAttemptStatus?: string
  flowId?: string
  revisionId?: string
  attemptId?: string
}
/**
 * Renderer-facing Hub Worker bridge. Credential material stays solely in the
 * main-process safeStorage record; public values intentionally contain no
 * endpoint, subject, node, key, token, private key, local path, or TaskHub
 * session/flow identifier.
 */
export function registerHubTaskWorkerHandlers(
  service: HubTaskWorkerServiceV1,
  installationIdDigest: string,
  login: (input: HubTaskWorkerAccountLoginInputV1) => Promise<{ endpoint: string; accessToken: string }> = loginHubTaskWorkerAccountV1,
): void {
  registerHandler('ipc:xiaogui.hubTask.status', async () => ({ ok: true as const, value: service.status() }))

  registerHandler('ipc:xiaogui.hubTask.connect', async (payload) => {
    const parsed = ConnectSchema.safeParse(payload)
    if (!parsed.success) return invalidInput()
    try {
      const session = await login(parsed.data)
      return service.connect({ ...session, installationIdDigest })
    } catch (error) {
      return {
        ok: false as const,
        code: error instanceof HubTaskWorkerHttpErrorV1 && error.code === 'AUTHENTICATION_FAILED'
          ? 'HUB_WORKER_AUTHENTICATION_FAILED' as const
          : 'HUB_WORKER_CONNECTION_FAILED' as const,
      }
    }
  })

  registerHandler('ipc:xiaogui.hubTask.refresh', async () => service.refresh())
  registerHandler('ipc:xiaogui.hubTask.inbox.list', async () => ({
    ok: true as const,
    value: service.listInbox().map(toPublicInboxItem),
  }))
  registerHandler('ipc:xiaogui.hubTask.inbox.open', async (payload) => {
    const parsed = AssignmentSchema.safeParse(payload)
    if (!parsed.success) return invalidInput()
    return mapItemResult(await service.openAssignment(parsed.data.assignmentId))
  })
  registerHandler('ipc:xiaogui.hubTask.inbox.decision', async (payload) => {
    const parsed = DecisionSchema.safeParse(payload)
    if (!parsed.success) return invalidInput()
    return mapItemResult(await service.decideAssignment(parsed.data.assignmentId, parsed.data.decision))
  })
  registerHandler('ipc:xiaogui.hubTask.inbox.return', async (payload) => {
    const parsed = AssignmentSchema.safeParse(payload)
    if (!parsed.success) return invalidInput()
    return mapItemResult(await service.returnAssignment(parsed.data.assignmentId))
  })
  registerHandler('ipc:xiaogui.hubTask.inbox.createPlanDraft', async (payload) => {
    const parsed = PlanDraftSchema.safeParse(payload)
    if (!parsed.success) return invalidInput()
    const result = await service.createPlanDraft(parsed.data.assignmentId, parsed.data.address as HubAddressV1)
    return result.ok
      ? { ok: true as const, value: { localPlanDraftCreated: true } }
      : result
  })
  registerHandler('ipc:xiaogui.hubTask.inbox.acceptAndExecute', async (payload) => {
    const parsed = AcceptAndExecuteSchema.safeParse(payload)
    if (!parsed.success) return invalidInput()
    const result = await service.acceptAndExecuteV2({
      contractVersion: 'hub.accept-execute.v2',
      ...parsed.data,
      address: parsed.data.address as HubAddressV1,
    })
    if (!result.ok) return result
    return {
      ok: true as const,
      value: {
        executionState: result.value.executionState,
        ...(result.value.actualAttemptStatus ? { actualAttemptStatus: result.value.actualAttemptStatus } : {}),
        ...(result.value.flowId ? { flowId: result.value.flowId } : {}),
        ...(result.value.revisionId ? { revisionId: result.value.revisionId } : {}),
        ...(result.value.attemptId ? { attemptId: result.value.attemptId } : {}),
      } satisfies HubTaskWorkerPublicAcceptAndExecuteResultV2,
    }
  })

}

function mapItemResult(result: Awaited<ReturnType<HubTaskWorkerServiceV1['openAssignment']>>) {
  return result.ok ? { ok: true as const, value: toPublicInboxItem(result.value) } : result
}

function toPublicInboxItem(entry: HubTaskWorkerInboxEntryV1): HubTaskWorkerPublicInboxItemV1 {
  const binding = entry.acceptAndExecuteV2
  // A legacy V1 plan already owns the assignment. Do not silently upgrade it
  // by manufacturing V2 metadata; an explicit new V2 acceptance is required.
  const canOfferV2 = binding !== undefined || entry.localPlanDraft === null
  return {
    assignmentId: entry.assignment.assignmentId,
    title: entry.offer.title,
    taskContent: entry.offer.taskContent,
    constraints: [...entry.offer.constraints],
    acceptanceRequirements: [...entry.offer.acceptanceRequirements],
    attachmentCount: entry.offer.attachmentRefs.length,
    mode: entry.offer.mode,
    decisionState: entry.assignment.decisionState,
    hubDeliveryState: entry.assignment.deliveryState,
    executionState: entry.assignment.executionState,
    openedAt: entry.openedAt,
    receiptPendingSync: entry.localDeliveryState === 'PENDING_H1_4_RECEIPT',
    localPlanDraftCreated: entry.localPlanDraft !== null,
    ...(canOfferV2 ? {
      acceptAndExecuteV2: {
        state: binding ? 'BOUND' as const : 'AVAILABLE' as const,
        requestId: binding?.requestId ?? stableAcceptAndExecuteRequestId(entry),
        observedPackageSha256: entry.offer.packageSha256,
        phase: binding?.phase ?? null,
        ...(binding ? { projectId: binding.projectId, sessionKey: binding.sessionKey } : {}),
        ...(binding?.flowId ? { flowId: binding.flowId } : {}),
        ...(binding?.revisionId ? { revisionId: binding.revisionId } : {}),
        ...(binding?.attemptId ? { attemptId: binding.attemptId } : {}),
        ...(binding?.executionState ? { executionState: binding.executionState } : {}),
      },
    } : {}),
  }
}

/**
 * A first click must be repeatable even if the Renderer is recreated before
 * Main has persisted the binding. The digest is only an idempotency key; it
 * does not grant authority and is never used as a target or path.
 */
function stableAcceptAndExecuteRequestId(entry: HubTaskWorkerInboxEntryV1): string {
  const digest = createHash('sha256')
    .update(`${entry.assignment.assignmentId}\0${entry.offer.packageSha256}`, 'utf8')
    .digest('hex')
  return `hub-accept-v2-${digest}`
}

function invalidInput() {
  return { ok: false as const, code: 'HUB_WORKER_INPUT_INVALID' as const }
}
