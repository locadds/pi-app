import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1,
  type CodingExtensionSafeErrorCodeV1,
  type CodingExtensionSafeErrorV1,
  type CodingPlanActionV1,
  type CodingPlanObserveOutcomeV1,
  type CodingPlanPerformOutcomeV1,
  type CodingReviewReadOutcomeV1,
} from '@shared/xiaogui-coding-extension-control'
import type { CodingPlanProjectionV1 } from '@shared/xiaogui-coding-extension-pack'

import { ipcClient } from '@renderer/lib/ipc-client'

const CONTRACT = XIAOGUI_CODING_EXTENSION_CONTROL_VERSION_V1
const DIGEST = /^sha256:[0-9a-f]{64}$/
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const MESSAGE_KEY = /^[a-z0-9._-]{1,160}$/i
const PLAN_STATES = new Set(['AWAITING_APPROVAL', 'APPROVED', 'EXECUTING'])
const PLAN_SOURCES = new Set(['PI_DRAFT', 'TASK_OBJECTIVE_FALLBACK'])
const TODO_STATES = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED'])
const REVIEW_STATES = new Set(['PASSED', 'FAILED', 'UNKNOWN'])
const ERROR_CODES = new Set<CodingExtensionSafeErrorCodeV1>([
  'INVALID_COMMAND',
  'PLAN_NOT_FOUND',
  'VERSION_CONFLICT',
  'PLAN_NOT_APPROVED',
  'PLAN_BODY_LOCKED',
  'TODO_NOT_FOUND',
  'INVALID_TODO_TRANSITION',
  'INVALID_REQUEST',
  'SESSION_SCOPE_MISMATCH',
  'EXECUTION_RESUME_FAILED',
  'REVIEW_UNAVAILABLE',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isSafeError(value: unknown): value is CodingExtensionSafeErrorV1 {
  return isRecord(value)
    && hasExactKeys(value, ['code', 'messageKey'])
    && ERROR_CODES.has(value.code as CodingExtensionSafeErrorCodeV1)
    && typeof value.messageKey === 'string'
    && MESSAGE_KEY.test(value.messageKey)
}

function isRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  if (/^[a-z]:/i.test(value) || /^[\\/]/.test(value)) return false
  return !value.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..')
}

function isPlanProjection(value: unknown): value is CodingPlanProjectionV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'attemptId',
    'source',
    'state',
    'plan',
    'planDigest',
  ])) return false
  if (
    value.schemaVersion !== 1
    || typeof value.attemptId !== 'string'
    || !SAFE_ID.test(value.attemptId)
    || !PLAN_SOURCES.has(String(value.source))
    || !PLAN_STATES.has(String(value.state))
    || typeof value.planDigest !== 'string'
    || !DIGEST.test(value.planDigest)
    || !isRecord(value.plan)
  ) return false
  const plan = value.plan
  if (!hasExactKeys(plan, [
    'schemaVersion',
    'planId',
    'attemptId',
    'objective',
    'steps',
    'constraints',
    'revision',
  ])) return false
  if (
    plan.schemaVersion !== 1
    || typeof plan.planId !== 'string'
    || !SAFE_ID.test(plan.planId)
    || plan.attemptId !== value.attemptId
    || typeof plan.objective !== 'string'
    || plan.objective.trim().length === 0
    || !Number.isSafeInteger(plan.revision)
    || (plan.revision as number) < 1
    || !Array.isArray(plan.constraints)
    || !plan.constraints.every((item) => typeof item === 'string' && item.trim().length > 0)
    || !Array.isArray(plan.steps)
    || plan.steps.length === 0
  ) return false
  const stepIds = new Set<string>()
  return plan.steps.every((step) => {
    if (!isRecord(step) || !hasExactKeys(step, ['stepId', 'title', 'status', 'validation'])) return false
    if (
      typeof step.stepId !== 'string'
      || !SAFE_ID.test(step.stepId)
      || stepIds.has(step.stepId)
      || typeof step.title !== 'string'
      || step.title.trim().length === 0
      || typeof step.validation !== 'string'
      || step.validation.trim().length === 0
      || !TODO_STATES.has(String(step.status))
    ) return false
    stepIds.add(step.stepId)
    return true
  })
}

function planFailure(): CodingPlanObserveOutcomeV1 {
  return { ok: false, error: { code: 'INVALID_REQUEST', messageKey: 'xiaogui.coding.extension.ipc' } }
}

function reviewFailure(): CodingReviewReadOutcomeV1 {
  return { ok: false, error: { code: 'REVIEW_UNAVAILABLE', messageKey: 'xiaogui.coding.extension.ipc' } }
}

export async function observeCodingAttemptPlans(address: HubAddressV1): Promise<CodingPlanObserveOutcomeV1> {
  try {
    const response: unknown = await ipcClient.invoke('xiaogui.coding.plan.observe', {
      contractVersion: CONTRACT,
      address,
    })
    if (!isRecord(response) || !hasExactKeys(response, response.ok === true ? ['ok', 'value'] : ['ok', 'error'])) {
      return planFailure()
    }
    if (response.ok === false) return isSafeError(response.error) ? response as CodingPlanObserveOutcomeV1 : planFailure()
    if (response.ok !== true || !isRecord(response.value)) return planFailure()
    const value = response.value
    if (
      !hasExactKeys(value, ['contractVersion', 'plans'])
      || value.contractVersion !== CONTRACT
      || !Array.isArray(value.plans)
      || !value.plans.every(isPlanProjection)
    ) return planFailure()
    const attemptIds = value.plans.map((item) => item.attemptId)
    if (new Set(attemptIds).size !== attemptIds.length) return planFailure()
    return response as CodingPlanObserveOutcomeV1
  } catch {
    return planFailure()
  }
}

export async function performCodingAttemptPlan(
  address: HubAddressV1,
  action: CodingPlanActionV1,
): Promise<CodingPlanPerformOutcomeV1> {
  try {
    const response: unknown = await ipcClient.invoke('xiaogui.coding.plan.perform', {
      contractVersion: CONTRACT,
      address,
      action,
    })
    if (!isRecord(response)) return planFailure() as CodingPlanPerformOutcomeV1
    if (response.ok === false) {
      const keys = response.projection === undefined ? ['ok', 'error'] : ['ok', 'error', 'projection']
      if (!hasExactKeys(response, keys) || !isSafeError(response.error)) return planFailure() as CodingPlanPerformOutcomeV1
      if (response.projection !== undefined && !isPlanProjection(response.projection)) {
        return planFailure() as CodingPlanPerformOutcomeV1
      }
      if (isRecord(response.projection) && response.projection.attemptId !== action.attemptId) {
        return planFailure() as CodingPlanPerformOutcomeV1
      }
      return response as CodingPlanPerformOutcomeV1
    }
    if (response.ok !== true || !hasExactKeys(response, ['ok', 'value']) || !isRecord(response.value)) {
      return planFailure() as CodingPlanPerformOutcomeV1
    }
    const value = response.value
    if (
      !hasExactKeys(value, ['contractVersion', 'projection', 'executionResume'])
      || value.contractVersion !== CONTRACT
      || !isPlanProjection(value.projection)
      || value.projection.attemptId !== action.attemptId
      || !['NOT_REQUESTED', 'RESUMED'].includes(String(value.executionResume))
    ) return planFailure() as CodingPlanPerformOutcomeV1
    return response as CodingPlanPerformOutcomeV1
  } catch {
    return planFailure() as CodingPlanPerformOutcomeV1
  }
}

export async function readCodingAttemptReview(
  address: HubAddressV1,
  attemptId: string,
): Promise<CodingReviewReadOutcomeV1> {
  try {
    const response: unknown = await ipcClient.invoke('xiaogui.coding.review.read', {
      contractVersion: CONTRACT,
      address,
      attemptId,
    })
    if (!isRecord(response) || !hasExactKeys(response, response.ok === true ? ['ok', 'value'] : ['ok', 'error'])) {
      return reviewFailure()
    }
    if (response.ok === false) return isSafeError(response.error) ? response as CodingReviewReadOutcomeV1 : reviewFailure()
    if (response.ok !== true || !isRecord(response.value)) return reviewFailure()
    const value = response.value
    if (
      !hasExactKeys(value, ['contractVersion', 'bundle', 'unifiedDiff', 'unifiedDiffDigest'])
      || value.contractVersion !== CONTRACT
      || typeof value.unifiedDiff !== 'string'
      || typeof value.unifiedDiffDigest !== 'string'
      || !DIGEST.test(value.unifiedDiffDigest)
      || !isRecord(value.bundle)
    ) return reviewFailure()
    const bundle = value.bundle
    if (!hasExactKeys(bundle, [
      'schemaVersion',
      'attemptId',
      'changeSetDigest',
      'changedRelativePaths',
      'verifications',
      'unresolvedIssues',
    ])) return reviewFailure()
    if (
      bundle.schemaVersion !== 1
      || bundle.attemptId !== attemptId
      || typeof bundle.changeSetDigest !== 'string'
      || !DIGEST.test(bundle.changeSetDigest)
      || !Array.isArray(bundle.changedRelativePaths)
      || !bundle.changedRelativePaths.every(isRelativePath)
      || new Set(bundle.changedRelativePaths).size !== bundle.changedRelativePaths.length
      || !Array.isArray(bundle.unresolvedIssues)
      || !bundle.unresolvedIssues.every((item) => typeof item === 'string')
      || !Array.isArray(bundle.verifications)
      || !bundle.verifications.every((verification) => {
        if (!isRecord(verification) || !hasExactKeys(verification, [
          'label',
          'commandDigest',
          'exitCode',
          'status',
        ])) return false
        return typeof verification.label === 'string'
          && verification.label.trim().length > 0
          && typeof verification.commandDigest === 'string'
          && DIGEST.test(verification.commandDigest)
          && (verification.exitCode === null || Number.isSafeInteger(verification.exitCode))
          && REVIEW_STATES.has(String(verification.status))
      })
    ) return reviewFailure()
    return response as CodingReviewReadOutcomeV1
  } catch {
    return reviewFailure()
  }
}
