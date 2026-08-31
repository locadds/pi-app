import { create } from 'zustand'

import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type {
  CodingExtensionSafeErrorV1,
  CodingReviewReadProjectionV1,
} from '@shared/xiaogui-coding-extension-control'
import type {
  CodingPlanBodyV1,
  CodingPlanProjectionV1,
  CodingPlanTodoStatusV1,
} from '@shared/xiaogui-coding-extension-pack'

import {
  observeCodingAttemptPlans,
  performCodingAttemptPlan,
  readCodingAttemptReview,
} from '../lib/coding-attempt-client'

interface CodingAttemptState {
  address: HubAddressV1 | null
  loadingPlans: boolean
  plansByAttempt: Record<string, CodingPlanProjectionV1>
  planObserveError: CodingExtensionSafeErrorV1 | null
  planErrorsByAttempt: Record<string, CodingExtensionSafeErrorV1>
  submittingAttemptIds: readonly string[]
  resumeRequiredByAttempt: Record<string, true>
  reviewsByAttempt: Record<string, CodingReviewReadProjectionV1>
  reviewErrorsByAttempt: Record<string, CodingExtensionSafeErrorV1>
  loadingReviewAttemptIds: readonly string[]

  setAddress: (address: HubAddressV1 | null) => void
  refreshPlans: () => Promise<boolean>
  revisePlan: (attemptId: string, body: CodingPlanBodyV1) => Promise<boolean>
  approveAndStart: (attemptId: string) => Promise<boolean>
  resumeExecution: (attemptId: string) => Promise<boolean>
  transitionTodo: (attemptId: string, stepId: string, nextStatus: CodingPlanTodoStatusV1) => Promise<boolean>
  loadReview: (attemptId: string) => Promise<boolean>
  clearPlanError: (attemptId: string) => void
  clearReviewError: (attemptId: string) => void
}

function sameAddress(a: HubAddressV1 | null, b: HubAddressV1 | null): boolean {
  if (!a || !b) return a === b
  return a.projectId === b.projectId && a.sessionKey === b.sessionKey
}

function withoutKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  const next = { ...source }
  delete next[key]
  return next
}

export const useCodingAttemptStore = create<CodingAttemptState>((set, get) => {
  let addressGeneration = 0

  const perform = async (
    attemptId: string,
    action: 'REVISE' | 'APPROVE' | 'RESUME' | 'TODO_TRANSITION',
    options?: {
      readonly body?: CodingPlanBodyV1
      readonly stepId?: string
      readonly nextStatus?: CodingPlanTodoStatusV1
    },
  ): Promise<boolean> => {
    const { address, plansByAttempt, submittingAttemptIds } = get()
    const projection = plansByAttempt[attemptId]
    if (!address || !projection || submittingAttemptIds.includes(attemptId)) return false
    const generation = addressGeneration
    set({
      submittingAttemptIds: [...submittingAttemptIds, attemptId],
      planErrorsByAttempt: withoutKey(get().planErrorsByAttempt, attemptId),
    })
    const version = {
      attemptId,
      expectedRevision: projection.plan.revision,
      expectedPlanDigest: projection.planDigest,
    }
    const command = action === 'REVISE'
      ? { type: 'REVISE' as const, ...version, body: options!.body! }
      : action === 'TODO_TRANSITION'
        ? {
            type: 'TODO_TRANSITION' as const,
            ...version,
            stepId: options!.stepId!,
            nextStatus: options!.nextStatus!,
          }
        : { type: action, ...version }
    const outcome = await performCodingAttemptPlan(address, command)
    if (generation !== addressGeneration || !sameAddress(get().address, address)) return false
    set({ submittingAttemptIds: get().submittingAttemptIds.filter((id) => id !== attemptId) })
    if (!outcome.ok) {
      const nextPlans = outcome.projection
        ? { ...get().plansByAttempt, [attemptId]: outcome.projection }
        : get().plansByAttempt
      set({
        plansByAttempt: nextPlans,
        planErrorsByAttempt: { ...get().planErrorsByAttempt, [attemptId]: outcome.error },
        resumeRequiredByAttempt: outcome.projection?.state === 'APPROVED'
          ? { ...get().resumeRequiredByAttempt, [attemptId]: true }
          : get().resumeRequiredByAttempt,
      })
      return false
    }
    set({
      plansByAttempt: { ...get().plansByAttempt, [attemptId]: outcome.value.projection },
      planErrorsByAttempt: withoutKey(get().planErrorsByAttempt, attemptId),
      resumeRequiredByAttempt: withoutKey(get().resumeRequiredByAttempt, attemptId),
    })
    return true
  }

  return {
    address: null,
    loadingPlans: false,
    plansByAttempt: {},
    planObserveError: null,
    planErrorsByAttempt: {},
    submittingAttemptIds: [],
    resumeRequiredByAttempt: {},
    reviewsByAttempt: {},
    reviewErrorsByAttempt: {},
    loadingReviewAttemptIds: [],

    setAddress: (address) => {
      if (address && sameAddress(get().address, address)) return
      addressGeneration += 1
      set({
        address,
        loadingPlans: false,
        plansByAttempt: {},
        planObserveError: null,
        planErrorsByAttempt: {},
        submittingAttemptIds: [],
        resumeRequiredByAttempt: {},
        reviewsByAttempt: {},
        reviewErrorsByAttempt: {},
        loadingReviewAttemptIds: [],
      })
    },

    refreshPlans: async () => {
      const address = get().address
      if (!address) return false
      const generation = addressGeneration
      set({ loadingPlans: true, planObserveError: null })
      const outcome = await observeCodingAttemptPlans(address)
      if (generation !== addressGeneration || !sameAddress(get().address, address)) return false
      if (!outcome.ok) {
        set({ loadingPlans: false, planObserveError: outcome.error })
        return false
      }
      const plansByAttempt: Record<string, CodingPlanProjectionV1> = {}
      const resumeRequiredByAttempt: Record<string, true> = {}
      for (const projection of outcome.value.plans) {
        plansByAttempt[projection.attemptId] = projection
        if (projection.state === 'APPROVED') resumeRequiredByAttempt[projection.attemptId] = true
      }
      set({ loadingPlans: false, plansByAttempt, resumeRequiredByAttempt, planObserveError: null })
      return true
    },

    revisePlan: (attemptId, body) => perform(attemptId, 'REVISE', { body }),
    approveAndStart: (attemptId) => perform(attemptId, 'APPROVE'),
    resumeExecution: (attemptId) => perform(attemptId, 'RESUME'),
    transitionTodo: (attemptId, stepId, nextStatus) =>
      perform(attemptId, 'TODO_TRANSITION', { stepId, nextStatus }),

    loadReview: async (attemptId) => {
      const { address, loadingReviewAttemptIds } = get()
      if (!address || loadingReviewAttemptIds.includes(attemptId)) return false
      const generation = addressGeneration
      set({
        loadingReviewAttemptIds: [...loadingReviewAttemptIds, attemptId],
        reviewErrorsByAttempt: withoutKey(get().reviewErrorsByAttempt, attemptId),
      })
      const outcome = await readCodingAttemptReview(address, attemptId)
      if (generation !== addressGeneration || !sameAddress(get().address, address)) return false
      set({ loadingReviewAttemptIds: get().loadingReviewAttemptIds.filter((id) => id !== attemptId) })
      if (!outcome.ok) {
        set({ reviewErrorsByAttempt: { ...get().reviewErrorsByAttempt, [attemptId]: outcome.error } })
        return false
      }
      set({
        reviewsByAttempt: { ...get().reviewsByAttempt, [attemptId]: outcome.value },
        reviewErrorsByAttempt: withoutKey(get().reviewErrorsByAttempt, attemptId),
      })
      return true
    },

    clearPlanError: (attemptId) => set({ planErrorsByAttempt: withoutKey(get().planErrorsByAttempt, attemptId) }),
    clearReviewError: (attemptId) => set({ reviewErrorsByAttempt: withoutKey(get().reviewErrorsByAttempt, attemptId) }),
  }
})
