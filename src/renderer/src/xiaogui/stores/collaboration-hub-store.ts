/**
 * 协作计划（M2B 投影）Renderer 状态。
 *
 * 领域事实只以主进程 projection 为准；本 store 只保存：
 * 当前 address、加载状态、主进程投影、临时新建表单、脱敏错误。
 * 切换 address 必须清空旧投影和表单，并丢弃晚到的旧请求结果。
 * 不做任何 localStorage / JSONL 持久化。
 */

import { create } from 'zustand'

import type {
  FlowId,
  HubAddressV1,
  HubSafeErrorV1,
  InitialPlanDraftInputV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type { DeliveryApplyAttemptV1, DeliveryBatchProjectionV1 } from '@shared/xiaogui-delivery'
import type { XiaoguiDeliveryOutcomeV1, XiaoguiDeliverySafeErrorV1 } from '@shared/xiaogui-delivery-ipc'
import type {
  XiaoguiTaskExecutionSafeErrorV1,
  XiaoguiTaskExecutionStartBatchRequestV1,
} from '@shared/xiaogui-task-execution'
import { XIAOGUI_TASK_EXECUTION_BATCH_CONTRACT_VERSION_V1 } from '@shared/xiaogui-task-execution'

import {
  approveDeliveryGate,
  newHubRequestId,
  observeCollaborationHub,
  performHubIntent,
  prepareDeliveryRecovery,
  reconcileDeliveryApply,
  retryDeliveryApply,
  returnDeliveryBatch,
  startTaskExecutionBatch,
  submitDeliverySelection,
} from '../lib/collaboration-hub-client'

/** 新建草稿临时表单的任务行（dependsOnText 为逗号/空白分隔的 taskKey 列表）。 */
export interface PlanTaskFormItem {
  taskKey: string
  title: string
  summary: string
  dependsOnText: string
}

/** 临时新建表单（仅内存，提交成功后清空；不得当作领域事实）。 */
export interface PlanDraftForm {
  objective: string
  tasks: PlanTaskFormItem[]
}

export function emptyPlanDraftForm(): PlanDraftForm {
  return {
    objective: '',
    tasks: [{ taskKey: '', title: '', summary: '', dependsOnText: '' }],
  }
}

/** 一次任务执行的临时输入，只留在 Renderer 内存中。 */
export interface TaskExecutionFormV1 {
  prompt: string
  modifyPathsText: string
  createPathsText: string
}

export function emptyTaskExecutionForm(): TaskExecutionFormV1 {
  return { prompt: '', modifyPathsText: '', createPathsText: '' }
}

/** 文件路径一行一条；纯空行忽略，非空行原样保留。 */
export function parseTaskExecutionPaths(text: string): string[] {
  return text.split(/\r?\n/).filter((path) => path.trim().length > 0)
}

function relativeFilePathError(relativePath: string): string | null {
  if (/^[a-zA-Z]:/.test(relativePath) || /^[\\/]/.test(relativePath)) return '只允许项目内相对路径'
  if (relativePath.includes('\0')) return '文件路径包含无效字符'
  const segments = relativePath.split(/[\\/]/)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return '文件路径不能包含空段、. 或 ..'
  }
  return null
}

export function validateTaskExecutionForm(form: TaskExecutionFormV1): string[] {
  const errors: string[] = []
  if (!form.prompt.trim()) errors.push('任务说明不能为空')

  const modifyPaths = parseTaskExecutionPaths(form.modifyPathsText)
  const createPaths = parseTaskExecutionPaths(form.createPathsText)
  if (modifyPaths.length + createPaths.length === 0) errors.push('至少需要填写一个允许修改或新建的文件')

  const seen = new Set<string>()
  for (const [operation, paths] of [
    ['修改', modifyPaths],
    ['新建', createPaths],
  ] as const) {
    for (const relativePath of paths) {
      if (relativePath !== relativePath.trim()) errors.push(`${operation}文件路径不能带首尾空白：${relativePath.trim()}`)
      const pathError = relativeFilePathError(relativePath)
      if (pathError) errors.push(`${operation}文件 ${relativePath}：${pathError}`)
      const canonical = relativePath.replaceAll('\\', '/')
      if (seen.has(canonical)) errors.push(`文件范围重复：${relativePath}`)
      else seen.add(canonical)
    }
  }
  return errors
}

/** 单个任务的执行载荷：trim 后的 prompt + MODIFY/CREATE 文件清单。 */
export function toTaskExecutionItemPayload(
  form: TaskExecutionFormV1,
): { prompt: string; files: XiaoguiTaskExecutionStartBatchRequestV1['items'][number]['files'] } {
  return {
    prompt: form.prompt.trim(),
    files: [
      ...parseTaskExecutionPaths(form.modifyPathsText).map((relativePath) => ({ operation: 'MODIFY' as const, relativePath })),
      ...parseTaskExecutionPaths(form.createPathsText).map((relativePath) => ({ operation: 'CREATE' as const, relativePath })),
    ],
  }
}

/** 当前投影中本批可执行任务：readiness 的 READY 列表按可用槽位截断，最多 2 个。 */
export function eligibleExecutionTaskRunIds(projection: SessionCollaborationProjectionM2BV1): TaskRunId[] {
  const readiness = projection.executionReadiness
  if (!readiness || readiness.availableSlots <= 0) return []
  return readiness.readyTaskRunIds.slice(0, Math.min(2, readiness.availableSlots))
}

/**
 * 批量执行的前端友好校验（主进程仍是最终判定者）：
 * 未选任务、空 prompt、空文件范围、同一任务重复路径，以及两个任务之间的
 * 路径大小写/斜杠别名重叠。冲突归属按 taskRunId 判定（标题允许重复，仅用于文案）。
 */
export function validateTaskExecutionBatch(
  items: readonly { taskRunId: TaskRunId; title: string; form: TaskExecutionFormV1 }[],
): string[] {
  const errors: string[] = []
  if (items.length === 0) {
    errors.push('请至少选择一个要执行的任务')
    return errors
  }
  const ownerByCanonicalPath = new Map<string, TaskRunId>()
  for (const { taskRunId, title, form } of items) {
    const prefix = items.length > 1 ? `「${title}」` : ''
    for (const message of validateTaskExecutionForm(form)) errors.push(`${prefix}${message}`)
    const paths = [...parseTaskExecutionPaths(form.modifyPathsText), ...parseTaskExecutionPaths(form.createPathsText)]
    for (const relativePath of paths) {
      const canonical = relativePath.replaceAll('\\', '/').toLowerCase()
      const owner = ownerByCanonicalPath.get(canonical)
      if (owner !== undefined && owner !== taskRunId) {
        errors.push(`两个任务的文件范围重叠：${relativePath}`)
      } else {
        ownerByCanonicalPath.set(canonical, taskRunId)
      }
    }
  }
  return errors
}

/** 表单 → 批量执行请求：公共 address/flowId + 逐项明确的 taskRunId/prompt/files。 */
export function toTaskExecutionStartBatchRequest(
  address: HubAddressV1,
  flowId: FlowId,
  items: readonly { taskRunId: TaskRunId; form: TaskExecutionFormV1 }[],
): XiaoguiTaskExecutionStartBatchRequestV1 {
  const mapped = items.map(({ taskRunId, form }) => ({ taskRunId, ...toTaskExecutionItemPayload(form) }))
  return {
    contractVersion: XIAOGUI_TASK_EXECUTION_BATCH_CONTRACT_VERSION_V1,
    address,
    flowId,
    // 调用方保证 1..2 项（校验先于构造）；显式构组避免把数组断言成元组
    items: mapped.length > 1 ? [mapped[0]!, mapped[1]!] : [mapped[0]!],
  }
}

export function parseDependsOnText(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 表单 → 新建 DTO：只含 objective、taskKey、title、可选 summary/dependsOn。 */
export function toInitialPlanDraft(form: PlanDraftForm): InitialPlanDraftInputV1 {
  return {
    objective: form.objective.trim(),
    tasks: form.tasks.map((task) => {
      const dependsOn = parseDependsOnText(task.dependsOnText)
      return {
        taskKey: task.taskKey.trim(),
        title: task.title.trim(),
        ...(task.summary.trim() ? { summary: task.summary.trim() } : {}),
        ...(dependsOn.length ? { dependsOn } : {}),
      }
    }),
  }
}

/**
 * 前端基础校验（只改善体验，主进程仍是最终判定者）。
 * 检查：空目标、空任务、任务标识/标题为空、重复 key、未知依赖、环依赖。
 */
export function validatePlanDraftForm(form: PlanDraftForm): string[] {
  const errors: string[] = []
  if (!form.objective.trim()) errors.push('目标不能为空')
  if (form.tasks.length === 0) errors.push('至少需要一个任务')

  const keys = new Set<string>()
  form.tasks.forEach((task, index) => {
    const key = task.taskKey.trim()
    if (!key) errors.push(`第 ${index + 1} 个任务的标识不能为空`)
    else if (keys.has(key)) errors.push(`任务标识重复：${key}`)
    else keys.add(key)
    if (!task.title.trim()) errors.push(`第 ${index + 1} 个任务的标题不能为空`)
  })

  const edges = new Map<string, string[]>()
  for (const task of form.tasks) {
    const key = task.taskKey.trim()
    if (!key) continue
    const deps = parseDependsOnText(task.dependsOnText)
    for (const dep of deps) {
      if (!keys.has(dep)) errors.push(`任务 ${key} 依赖了未知任务：${dep}`)
    }
    edges.set(
      key,
      deps.filter((dep) => keys.has(dep)),
    )
  }

  // 环检测（三色 DFS）
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const visit = (node: string): boolean => {
    color.set(node, GRAY)
    for (const next of edges.get(node) ?? []) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) return true
      if (c === WHITE && visit(next)) return true
    }
    color.set(node, BLACK)
    return false
  }
  for (const key of edges.keys()) {
    if ((color.get(key) ?? WHITE) === WHITE && visit(key)) {
      errors.push('任务依赖存在循环')
      break
    }
  }

  return errors
}

/** 安全错误 → 中文短文案（只展示 code + 文案 + traceId，不展示路径/栈/原始对象）。 */
export const HUB_ERROR_TEXT: Record<HubSafeErrorV1['code'], string> = {
  SESSION_SCOPE_MISMATCH: '会话作用域不匹配',
  DESIGN_RESERVED: '规划设计模式暂未开放协作计划',
  DRAFT_INVALID: '草稿未通过校验',
  ACTIVE_FLOW_EXISTS: '已存在进行中的协作计划',
  FLOW_NOT_FOUND: '协作计划不存在',
  REVISION_NOT_FOUND: '计划版本不存在或已被处理',
  REVISION_CONFLICT: '计划版本内容不一致',
  STALE_SESSION_VERSION: '会话状态已变化，请刷新后重试',
  IDEMPOTENCY_CONFLICT: '请求标识冲突，请重试',
  INTENT_DISABLED: '该能力暂未开放',
  IPC_VERSION_UNSUPPORTED: '契约版本不受支持',
  ILLEGAL_TRANSITION: '当前状态不允许执行该操作',
  RUNTIME_SELECTION_NOT_APPROVED: '运行时尚未批准',
  INTERNAL: '内部错误',
}

export const DEFAULT_CANCEL_REASON = '用户取消当前协作计划'

export const TASK_EXECUTION_ERROR_TEXT: Record<XiaoguiTaskExecutionSafeErrorV1['code'], string> = {
  SESSION_SCOPE_MISMATCH: '会话作用域不匹配',
  DESIGN_RESERVED: '规划设计模式暂不执行任务',
  WORK_NOT_SUPPORTED: '日常工作模式暂不支持此执行入口',
  FLOW_NOT_READY: '当前计划尚未进入可执行状态',
  EXECUTION_INPUT_INVALID: '任务说明或文件范围无效',
  EXECUTION_IN_PROGRESS: '已有任务正在准备或执行',
  AGENT_UNAVAILABLE: '执行智能体当前不可用',
  BASELINE_UNAVAILABLE: '无法确认项目当前基线',
  WORKSPACE_PREPARATION_FAILED: '独立工作区准备失败',
  OUTCOME_UNKNOWN: '执行结果未知，请查看最新任务状态',
  INTERNAL: '内部错误',
}

export const DELIVERY_ERROR_TEXT: Record<XiaoguiDeliverySafeErrorV1['code'], string> = {
  IPC_VERSION_UNSUPPORTED: '交付契约版本不受支持',
  DELIVERY_INPUT_INVALID: '交付请求未通过校验',
  STALE_DELIVERY_SUBJECT: '交付内容已变化，请刷新后重试',
  DELIVERY_NOT_FOUND: '交付批次不存在',
  ILLEGAL_TRANSITION: '当前交付状态不允许执行该操作',
  INTERNAL: '交付内部错误',
}

const DELIVERY_FAILED_APPLY_STATES = new Set<DeliveryApplyAttemptV1['state']>(['FAILED', 'FAILED_ROLLED_BACK'])
const DELIVERY_NON_RETRYABLE_APPLY_SAFE_CODES = new Set<NonNullable<DeliveryApplyAttemptV1['safeCode']>>([
  'TARGET_BASELINE_DRIFT',
  'TARGET_STATUS_DIRTY',
  'TARGET_FILE_DRIFT',
])

function isFailedApplyAttempt(applyAttempt: DeliveryApplyAttemptV1 | undefined): applyAttempt is DeliveryApplyAttemptV1 {
  return Boolean(applyAttempt && DELIVERY_FAILED_APPLY_STATES.has(applyAttempt.state))
}

function hasExplicitEmptyChangedRelativePaths(applyAttempt: DeliveryApplyAttemptV1 | undefined): boolean {
  return Array.isArray(applyAttempt?.changedRelativePaths) && applyAttempt.changedRelativePaths.length === 0
}

interface CollaborationHubState {
  address: HubAddressV1 | null
  loading: boolean
  submitting: boolean
  projection: SessionCollaborationProjectionM2BV1 | null
  error: HubSafeErrorV1 | null
  form: PlanDraftForm
  formErrors: string[]
  executionFlowId: FlowId | null
  /** 按 taskRunId 保存的逐任务临时输入（仅内存；成功项提交后即清除）。 */
  executionForms: Record<string, TaskExecutionFormV1>
  /** 本批勾选的任务（默认当前最多可执行项；仅保留仍为 READY 的任务）。 */
  selectedExecutionTaskRunIds: TaskRunId[]
  executionFormErrors: string[]
  executionReviewing: boolean
  executionError: XiaoguiTaskExecutionSafeErrorV1 | null
  /** 批量结果中失败项的安全错误，按 taskRunId 挂到对应任务卡片。 */
  executionItemErrors: Record<string, XiaoguiTaskExecutionSafeErrorV1>
  selectedDeliveryTaskRunIds: TaskRunId[]
  deliveryReviewSubjectKey: string | null
  deliveryError: XiaoguiDeliverySafeErrorV1 | null

  /** 切换 address 时清空旧投影与临时表单；相同 address 为 no-op。 */
  setAddress: (address: HubAddressV1 | null) => void
  /** 快照刷新（非订阅流）。 */
  refresh: () => Promise<void>
  setForm: (form: PlanDraftForm) => void
  startWithDraft: () => Promise<void>
  /** 原样批准投影携带的 canonical draft（不使用内存表单内容）。 */
  approveActiveRevision: () => Promise<void>
  cancelActiveFlow: (reason?: string) => Promise<boolean>
  setExecutionForm: (taskRunId: TaskRunId, form: TaskExecutionFormV1) => void
  toggleExecutionTaskSelection: (taskRunId: TaskRunId) => void
  reviewExecutionBatch: () => boolean
  returnToExecutionBatchEdit: () => void
  startExecutionBatch: () => Promise<boolean>
  reviewActiveDelivery: () => boolean
  toggleDeliveryTaskSelection: (taskRunId: TaskRunId) => void
  createDeliveryFromSelection: () => Promise<boolean>
  returnToDeliveryReview: () => void
  approveActiveDelivery: () => Promise<boolean>
  rejectActiveDelivery: (reason?: string) => Promise<boolean>
  reconcileActiveDelivery: () => Promise<boolean>
  retryActiveDelivery: () => Promise<boolean>
  prepareActiveDeliveryRecovery: () => Promise<boolean>
  clearError: () => void
  clearExecutionError: () => void
  clearDeliveryError: () => void
}

function sameAddress(a: HubAddressV1 | null, b: HubAddressV1 | null): boolean {
  if (!a || !b) return a === b
  return a.projectId === b.projectId && a.sessionKey === b.sessionKey
}

export const useCollaborationHubStore = create<CollaborationHubState>((set, get) => {
  // 请求序号：切换 address / 新 refresh 后，晚到的旧结果一律丢弃
  let requestSeq = 0
  // 执行请求独立序号：地址或 Flow 变化会使旧响应失效并解除当前提交锁。
  let executionSeq = 0

  const runIntent = async (
    build: (projection: SessionCollaborationProjectionM2BV1 | null) => Parameters<typeof performHubIntent>[1] | null,
  ): Promise<boolean> => {
    if (get().submitting) return false
    const { address, projection } = get()
    if (!address) return false
    const request = build(projection)
    if (!request) return false
    set({ submitting: true, error: null })
    const outcome = await performHubIntent(address, request)
    // 会话已切换：丢弃晚到结果，不污染新会话的状态
    if (!sameAddress(get().address, address)) return false
    if (!outcome.ok) {
      // 失败不产生状态变更：保留脱敏错误，不用随后的 observe 覆盖它
      set({ submitting: false, error: outcome.error })
      return false
    }
    set({ submitting: false })
    await get().refresh()
    return sameAddress(get().address, address)
  }

  const runDeliveryIntent = async (
    build: (
      address: HubAddressV1,
      projection: SessionCollaborationProjectionM2BV1,
    ) => Promise<XiaoguiDeliveryOutcomeV1<DeliveryBatchProjectionV1>> | null,
  ): Promise<boolean> => {
    if (get().submitting) return false
    const { address, projection } = get()
    if (!address || !projection) return false
    const task = build(address, projection)
    if (!task) return false
    set({ submitting: true, deliveryError: null })
    const outcome = await task
    if (!sameAddress(get().address, address)) return false
    if (!outcome.ok) {
      set({ submitting: false, deliveryError: outcome.error })
      return false
    }
    set({ submitting: false, selectedDeliveryTaskRunIds: [], deliveryReviewSubjectKey: null })
    await get().refresh()
    return sameAddress(get().address, address)
  }

  return {
    address: null,
    loading: false,
    submitting: false,
    projection: null,
    error: null,
    form: emptyPlanDraftForm(),
    formErrors: [],
    executionFlowId: null,
    executionForms: {},
    selectedExecutionTaskRunIds: [],
    executionFormErrors: [],
    executionReviewing: false,
    executionError: null,
    executionItemErrors: {},
    selectedDeliveryTaskRunIds: [],
    deliveryReviewSubjectKey: null,
    deliveryError: null,

    setAddress: (address) => {
      if (sameAddress(get().address, address)) return
      requestSeq += 1
      executionSeq += 1
      set({
        address,
        loading: false,
        submitting: false,
        projection: null,
        error: null,
        form: emptyPlanDraftForm(),
        formErrors: [],
        executionFlowId: null,
        executionForms: {},
        selectedExecutionTaskRunIds: [],
        executionFormErrors: [],
        executionReviewing: false,
        executionError: null,
        executionItemErrors: {},
        selectedDeliveryTaskRunIds: [],
        deliveryReviewSubjectKey: null,
        deliveryError: null,
      })
    },

    refresh: async () => {
      const address = get().address
      if (!address) return
      const seq = ++requestSeq
      set({ loading: true })
      const outcome = await observeCollaborationHub(address)
      if (seq !== requestSeq) return
      if (outcome.ok) {
        const nextFlowId = outcome.value.activeFlow?.flowId ?? null
        const flowChanged = get().executionFlowId !== nextFlowId
        const nextDeliverySubjectKey = deliverySubjectKey(outcome.value.activeDelivery ?? null)
        const keepDeliveryReview = get().deliveryReviewSubjectKey === nextDeliverySubjectKey
        if (flowChanged) executionSeq += 1
        // READY/槽位收敛：表单与选择只保留仍为 READY 且落在可用槽位内的任务；
        // 新 Flow 默认勾选当前最多可执行项；availableSlots=0 时选择清空并退出复核。
        const eligible = eligibleExecutionTaskRunIds(outcome.value)
        const keptSelected = flowChanged
          ? []
          : get().selectedExecutionTaskRunIds.filter((taskRunId) => eligible.includes(taskRunId))
        const nextSelected = flowChanged ? [...eligible] : keptSelected
        const nextForms: Record<string, TaskExecutionFormV1> = {}
        if (!flowChanged) {
          for (const [taskRunId, form] of Object.entries(get().executionForms)) {
            if (eligible.includes(taskRunId as TaskRunId)) nextForms[taskRunId] = form
          }
        }
        const nextItemErrors: Record<string, XiaoguiTaskExecutionSafeErrorV1> = {}
        if (!flowChanged) {
          for (const [taskRunId, itemError] of Object.entries(get().executionItemErrors)) {
            if (eligible.includes(taskRunId as TaskRunId)) nextItemErrors[taskRunId] = itemError
          }
        }
        set({
          loading: false,
          projection: outcome.value,
          error: null,
          executionFlowId: nextFlowId,
          executionForms: nextForms,
          selectedExecutionTaskRunIds: nextSelected,
          executionReviewing: !flowChanged && get().executionReviewing && nextSelected.length > 0,
          executionItemErrors: nextItemErrors,
          selectedDeliveryTaskRunIds: flowChanged || outcome.value.activeDelivery ? [] : get().selectedDeliveryTaskRunIds,
          deliveryReviewSubjectKey: keepDeliveryReview ? get().deliveryReviewSubjectKey : null,
          ...(flowChanged ? { submitting: false } : {}),
          ...(flowChanged
            ? {
                executionFormErrors: [],
                executionError: null,
                deliveryError: null,
              }
            : {}),
        })
      } else {
        set({ loading: false, error: outcome.error })
      }
    },

    setForm: (form) => set({ form, formErrors: [] }),

    startWithDraft: async () => {
      const { projection, form } = get()
      if (!projection?.availableActions.includes('flow.start.with_draft')) return
      const errors = validatePlanDraftForm(form)
      if (errors.length > 0) {
        set({ formErrors: errors })
        return
      }
      const draft = toInitialPlanDraft(form)
      const ok = await runIntent((current) => ({
        requestId: newHubRequestId(),
        expectedSessionVersion: current?.sessionVersion,
        intent: { type: 'flow.start.with_draft', draft },
      }))
      // 仅成功才清空临时表单（投影已携带权威草稿）；失败保留表单与错误
      if (ok) set({ form: emptyPlanDraftForm() })
    },

    approveActiveRevision: async () => {
      if (!get().projection?.availableActions.includes('plan.revision.submit')) return
      await runIntent((current) => {
        const flow = current?.activeFlow
        const revision = current?.activeRevision
        if (!current || !flow || !revision) return null
        return {
          requestId: newHubRequestId(),
          expectedSessionVersion: current.sessionVersion,
          intent: {
            type: 'plan.revision.submit',
            flowId: flow.flowId,
            baseRevisionId: revision.revisionId,
            // 原样回传主进程投影携带的 canonical draft，不用内存表单
            draft: revision.draft,
          },
        }
      })
    },

    cancelActiveFlow: async (reason) => {
      if (!get().projection?.availableActions.includes('flow.cancel')) return false
      return runIntent((current) => {
        const flow = current?.activeFlow
        if (!current || !flow) return null
        return {
          requestId: newHubRequestId(),
          expectedSessionVersion: current.sessionVersion,
          intent: {
            type: 'flow.cancel',
            flowId: flow.flowId,
            reason: reason?.trim() || DEFAULT_CANCEL_REASON,
          },
        }
      })
    },

    setExecutionForm: (taskRunId, form) => {
      if (get().submitting) return
      set({
        executionForms: { ...get().executionForms, [taskRunId]: form },
        executionFormErrors: [],
        executionError: null,
      })
    },

    toggleExecutionTaskSelection: (taskRunId) => {
      const { projection, submitting, executionReviewing, selectedExecutionTaskRunIds } = get()
      if (submitting || executionReviewing || !projection) return
      if (!eligibleExecutionTaskRunIds(projection).includes(taskRunId)) return
      set({
        selectedExecutionTaskRunIds: selectedExecutionTaskRunIds.includes(taskRunId)
          ? selectedExecutionTaskRunIds.filter((item) => item !== taskRunId)
          : [...selectedExecutionTaskRunIds, taskRunId],
        executionFormErrors: [],
        executionError: null,
      })
    },

    reviewExecutionBatch: () => {
      const { projection, executionForms, selectedExecutionTaskRunIds } = get()
      if (!projection?.availableActions.includes('execution.next.confirm')) return false
      const items = batchExecutionItems(projection, selectedExecutionTaskRunIds, executionForms)
      const executionFormErrors = validateTaskExecutionBatch(items)
      if (executionFormErrors.length > 0) {
        set({ executionFormErrors, executionReviewing: false })
        return false
      }
      set({ executionFormErrors: [], executionReviewing: true, executionError: null, executionItemErrors: {} })
      return true
    },

    returnToExecutionBatchEdit: () => {
      if (get().submitting) return
      set({ executionReviewing: false, executionError: null })
    },

    startExecutionBatch: async () => {
      const { address, projection, executionForms, selectedExecutionTaskRunIds, executionReviewing, submitting } = get()
      const flow = projection?.activeFlow
      if (
        submitting ||
        !address ||
        !flow ||
        !executionReviewing ||
        !projection.availableActions.includes('execution.next.confirm')
      )
        return false

      const items = batchExecutionItems(projection, selectedExecutionTaskRunIds, executionForms)
      const executionFormErrors = validateTaskExecutionBatch(items)
      if (executionFormErrors.length > 0) {
        set({ executionFormErrors, executionReviewing: false })
        return false
      }

      const flowId = flow.flowId
      const request = toTaskExecutionStartBatchRequest(address, flowId, items)
      const executionRequestSeq = ++executionSeq
      set({ submitting: true, executionError: null, executionItemErrors: {} })
      const outcome = await startTaskExecutionBatch(request)
      if (
        executionRequestSeq !== executionSeq ||
        !sameAddress(get().address, address) ||
        get().executionFlowId !== flowId
      )
        return false

      if (!outcome.ok) {
        set({ submitting: false, executionError: outcome.error })
        if (outcome.error.code === 'OUTCOME_UNKNOWN') await get().refresh()
        return false
      }

      // 逐项收敛：成功项清空表单并移出选择；失败项保留输入并挂对应安全错误
      const succeededIds = new Set<string>()
      const itemErrors: Record<string, XiaoguiTaskExecutionSafeErrorV1> = {}
      for (const item of outcome.value.items) {
        if (item.ok) succeededIds.add(item.taskRunId)
        else itemErrors[item.taskRunId] = item.error
      }
      const nextForms = { ...get().executionForms }
      for (const taskRunId of succeededIds) delete nextForms[taskRunId]
      set({
        submitting: false,
        executionForms: nextForms,
        selectedExecutionTaskRunIds: get().selectedExecutionTaskRunIds.filter((id) => !succeededIds.has(id)),
        executionFormErrors: [],
        executionItemErrors: itemErrors,
        executionError: null,
        executionReviewing: false,
      })
      await get().refresh()
      return sameAddress(get().address, address) && get().executionFlowId === flowId
    },

    reviewActiveDelivery: () => {
      const delivery = get().projection?.activeDelivery
      if (!delivery?.gate || delivery.gate.state !== 'OPEN') return false
      if (!get().projection?.availableActions.includes('delivery.gate.approve')) return false
      set({ deliveryReviewSubjectKey: deliverySubjectKey(delivery), deliveryError: null })
      return true
    },

    toggleDeliveryTaskSelection: (taskRunId) => {
      if (get().submitting || get().projection?.activeDelivery) return
      const current = get().selectedDeliveryTaskRunIds
      set({
        selectedDeliveryTaskRunIds: current.includes(taskRunId)
          ? current.filter((item) => item !== taskRunId)
          : [...current, taskRunId],
        deliveryError: null,
      })
    },

    createDeliveryFromSelection: async () => {
      const selected = get().selectedDeliveryTaskRunIds
      if (selected.length === 0) return false
      return runDeliveryIntent((address, current) => {
        if (current.activeDelivery || !current.activeFlow || !current.availableActions.includes('delivery.selection.submit')) return null
        return submitDeliverySelection(address, {
          requestId: newHubRequestId(),
          flowId: current.activeFlow.flowId,
          taskRunIds: selected,
        })
      })
    },

    returnToDeliveryReview: () => {
      if (get().submitting) return
      set({ deliveryReviewSubjectKey: null, deliveryError: null })
    },

    approveActiveDelivery: async () =>
      runDeliveryIntent((address, current) => {
        const delivery = current.activeDelivery
        if (
          !delivery?.gate ||
          delivery.gate.state !== 'OPEN' ||
          !current.availableActions.includes('delivery.gate.approve') ||
          get().deliveryReviewSubjectKey !== deliverySubjectKey(delivery)
        )
          return null
        return approveDeliveryGate(address, {
          requestId: newHubRequestId(),
          gateId: delivery.gate.gateId,
          subject: delivery.gate.subject,
        })
      }),

    rejectActiveDelivery: async (reason) =>
      runDeliveryIntent((address, current) => {
        const delivery = current.activeDelivery
        if (!delivery?.gate || delivery.gate.state !== 'OPEN' || !current.availableActions.includes('delivery.gate.reject')) return null
        return returnDeliveryBatch(address, {
          requestId: newHubRequestId(),
          gateId: delivery.gate.gateId,
          subject: delivery.gate.subject,
          ...(reason?.trim() ? { rejectionReason: reason.trim() } : {}),
        })
      }),

    reconcileActiveDelivery: async () =>
      runDeliveryIntent((address, current) => {
        const delivery = current.activeDelivery
        if (!delivery || !current.availableActions.includes('apply.reconcile.request')) return null
        return reconcileDeliveryApply(address, {
          requestId: newHubRequestId(),
          batchId: delivery.batchId,
          ...(delivery.applyAttempt ? { applyAttemptId: delivery.applyAttempt.applyAttemptId } : {}),
        })
      }),

    retryActiveDelivery: async () =>
      runDeliveryIntent((address, current) => {
        const delivery = current.activeDelivery
        const applyAttempt = delivery?.applyAttempt
        if (
          !delivery ||
          !current.availableActions.includes('apply.retry.request') ||
          !isFailedApplyAttempt(applyAttempt) ||
          (applyAttempt.safeCode !== undefined && DELIVERY_NON_RETRYABLE_APPLY_SAFE_CODES.has(applyAttempt.safeCode))
        )
          return null
        return retryDeliveryApply(address, {
          requestId: newHubRequestId(),
          batchId: delivery.batchId,
          failedApplyAttemptId: applyAttempt.applyAttemptId,
        })
      }),

    prepareActiveDeliveryRecovery: async () =>
      runDeliveryIntent((address, current) => {
        const delivery = current.activeDelivery
        const applyAttempt = delivery?.applyAttempt
        if (
          !delivery ||
          !current.availableActions.includes('apply.recovery.prepare') ||
          !isFailedApplyAttempt(applyAttempt) ||
          applyAttempt.safeCode !== 'TARGET_BASELINE_DRIFT' ||
          !hasExplicitEmptyChangedRelativePaths(applyAttempt)
        )
          return null
        return prepareDeliveryRecovery(address, {
          requestId: newHubRequestId(),
          batchId: delivery.batchId,
          failedApplyAttemptId: applyAttempt.applyAttemptId,
        })
      }),

    clearError: () => set({ error: null }),
    clearExecutionError: () => set({ executionError: null }),
    clearDeliveryError: () => set({ deliveryError: null }),
  }
})

/**
 * 当前勾选且仍可执行的任务 → {taskRunId, title, form}。
 * title 只用于本地校验报错提示，不进入执行请求；未填写的表单按空表单参与校验。
 */
function batchExecutionItems(
  projection: SessionCollaborationProjectionM2BV1,
  selectedTaskRunIds: readonly TaskRunId[],
  forms: Record<string, TaskExecutionFormV1>,
): { taskRunId: TaskRunId; title: string; form: TaskExecutionFormV1 }[] {
  const eligible = eligibleExecutionTaskRunIds(projection)
  const titleByKey = new Map(projection.taskSpecs.map((spec) => [spec.taskKey, spec.title]))
  const titleByRunId = new Map(projection.taskRuns.map((run) => [run.taskRunId, titleByKey.get(run.taskKey) ?? '协作任务']))
  return selectedTaskRunIds
    .filter((taskRunId) => eligible.includes(taskRunId))
    .map((taskRunId) => ({
      taskRunId,
      title: titleByRunId.get(taskRunId) ?? '协作任务',
      form: forms[taskRunId] ?? emptyTaskExecutionForm(),
    }))
}

function deliverySubjectKey(delivery: DeliveryBatchProjectionV1 | null): string | null {
  if (!delivery?.gate) return null
  return `${delivery.gate.gateId}:${delivery.gate.subject.deliveryChangeSetId}:${delivery.gate.subject.version}:${delivery.gate.subject.digest}`
}
