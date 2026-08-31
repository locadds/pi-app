import { z } from 'zod'

import {
  XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
  type CodingExtensionSafeErrorCodeV1,
  type CodingExtensionSafeErrorV1,
  type CodingPlanPerformOutcomeV1,
  type CodingPlanPerformRequestV1,
  type CodingPlanObserveOutcomeV1,
  type CodingReviewReadOutcomeV1,
} from '@shared/xiaogui-coding-extension-control'
import type { CodingPlanCommandOutcomeV1, CodingPlanProjectionV1 } from '@shared/xiaogui-coding-extension-pack'
import type { AttemptId, HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

import { registerHandler } from '../../ipc/registry'
import type { CodingAttemptPlanModuleV1 } from './attempt-plan-module'
import {
  CodingAttemptReviewErrorV1,
  type CodingAttemptReviewModuleV1,
} from './attempt-review-module'

const AddressSchema = z.object({
  projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
  sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
}).strict()

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const SafeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/i)
const VersionFields = {
  attemptId: SafeIdSchema,
  expectedRevision: z.number().int().positive(),
  expectedPlanDigest: DigestSchema,
}
const PlanBodySchema = z.object({
  objective: z.string().trim().min(1).max(8_000),
  steps: z.array(z.object({
    stepId: SafeIdSchema,
    title: z.string().trim().min(1).max(1_000),
    validation: z.string().trim().min(1).max(2_000),
  }).strict()).min(1).max(128),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(128),
}).strict()

const ObserveSchema = z.object({
  contractVersion: z.literal(XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1),
  address: AddressSchema,
}).strict()
const PerformSchema = z.object({
  contractVersion: z.literal(XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1),
  address: AddressSchema,
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('REVISE'), ...VersionFields, body: PlanBodySchema }).strict(),
    z.object({ type: z.literal('APPROVE'), ...VersionFields }).strict(),
    z.object({ type: z.literal('RESUME'), ...VersionFields }).strict(),
    z.object({
      type: z.literal('TODO_TRANSITION'),
      ...VersionFields,
      stepId: SafeIdSchema,
      nextStatus: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED']),
    }).strict(),
  ]),
}).strict()
const ReviewSchema = z.object({
  contractVersion: z.literal(XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1),
  address: AddressSchema,
  attemptId: SafeIdSchema,
}).strict()

type PlanPortV1 = Pick<
  CodingAttemptPlanModuleV1,
  'observe' | 'revise' | 'approve' | 'transitionTodo' | 'getProjection'
>
type ReviewPortV1 = Pick<CodingAttemptReviewModuleV1, 'read'>
type TaskExecutionPortV1 = {
  resumeAttempt(address: HubAddressV1, attemptId: AttemptId): Promise<{ readonly ok: boolean }>
}

export function registerCodingAttemptHandlersV1(options: {
  readonly plan: PlanPortV1
  readonly review: ReviewPortV1
  readonly taskExecution: TaskExecutionPortV1
}): void {
  registerHandler('ipc:xiaogui.coding.plan.observe', async (payload): Promise<CodingPlanObserveOutcomeV1> => {
    const parsed = ObserveSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    try {
      return {
        ok: true,
        value: {
          contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
      plans: options.plan.observe(parsed.data.address as HubAddressV1),
        },
      }
    } catch {
      return failure('INVALID_REQUEST')
    }
  })

  registerHandler('ipc:xiaogui.coding.plan.perform', async (payload): Promise<CodingPlanPerformOutcomeV1> => {
    const parsed = PerformSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const request = parsed.data as unknown as CodingPlanPerformRequestV1
    const scoped = scopedPlan(options.plan, request.address, request.action.attemptId)
    if (!scoped) return failure('SESSION_SCOPE_MISMATCH')

    if (request.action.type === 'RESUME') {
      if (
        scoped.state !== 'APPROVED' ||
        scoped.plan.revision !== request.action.expectedRevision ||
        scoped.planDigest !== request.action.expectedPlanDigest
      ) return failure('VERSION_CONFLICT')
      return resume(options.plan, options.taskExecution, request.address, scoped)
    }

    let outcome: CodingPlanCommandOutcomeV1
    if (request.action.type === 'REVISE') {
      outcome = options.plan.revise({ schemaVersion: 1, ...request.action })
    } else if (request.action.type === 'APPROVE') {
      outcome = options.plan.approve({ schemaVersion: 1, ...request.action })
    } else {
      outcome = options.plan.transitionTodo({ schemaVersion: 1, ...request.action })
    }
    if (!outcome.ok) return failure(outcome.error)
    if (request.action.type === 'APPROVE') {
      return resume(options.plan, options.taskExecution, request.address, outcome.projection)
    }
    return {
      ok: true,
      value: {
        contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
        projection: outcome.projection,
        executionResume: 'NOT_REQUESTED',
      },
    }
  })

  registerHandler('ipc:xiaogui.coding.review.read', async (payload): Promise<CodingReviewReadOutcomeV1> => {
    const parsed = ReviewSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    try {
      const projection = await options.review.read({
        address: parsed.data.address as HubAddressV1,
        attemptId: parsed.data.attemptId as AttemptId,
      })
      return {
        ok: true,
        value: {
          contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
          ...projection,
        },
      }
    } catch (error) {
      if (error instanceof CodingAttemptReviewErrorV1) {
        if (error.reasonCode === 'ATTEMPT_NOT_FOUND' || error.reasonCode === 'ATTEMPT_SCOPE_UNAVAILABLE') {
          return failure('SESSION_SCOPE_MISMATCH')
        }
      }
      return failure('REVIEW_UNAVAILABLE')
    }
  })
}

function scopedPlan(plan: PlanPortV1, address: HubAddressV1, attemptId: string): CodingPlanProjectionV1 | null {
  try {
    return plan.observe(address).find((candidate) => candidate.attemptId === attemptId) ?? null
  } catch {
    return null
  }
}

async function resume(
  plan: PlanPortV1,
  taskExecution: TaskExecutionPortV1,
  address: HubAddressV1,
  projection: CodingPlanProjectionV1,
): Promise<CodingPlanPerformOutcomeV1> {
  try {
    const resumed = await taskExecution.resumeAttempt(address, projection.attemptId as AttemptId)
    if (!resumed.ok) {
      return {
        ...failure('EXECUTION_RESUME_FAILED'),
        projection: plan.getProjection(projection.attemptId) ?? projection,
      }
    }
  } catch {
    // Never let a runtime/TaskHub exception escape through the public IPC
    // registry where paths or private execution details could be logged.
    return {
      ...failure('EXECUTION_RESUME_FAILED'),
      projection: plan.getProjection(projection.attemptId) ?? projection,
    }
  }
  return {
    ok: true,
    value: {
      contractVersion: XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
      projection: plan.getProjection(projection.attemptId) ?? projection,
      executionResume: 'RESUMED',
    },
  }
}

function failure(code: CodingExtensionSafeErrorCodeV1): {
  readonly ok: false
  readonly error: CodingExtensionSafeErrorV1
} {
  return { ok: false, error: { code, messageKey: `xiaogui.coding.extension.${code.toLowerCase()}` } }
}
