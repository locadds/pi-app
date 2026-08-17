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
  HubAddressV1,
  HubSafeErrorV1,
  InitialPlanDraftInputV1,
  SessionCollaborationProjectionM2BV1,
} from '@shared/xiaogui-collaboration-hub'

import { newHubRequestId, observeCollaborationHub, performHubIntent } from '../lib/collaboration-hub-client'

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

interface CollaborationHubState {
  address: HubAddressV1 | null
  loading: boolean
  submitting: boolean
  projection: SessionCollaborationProjectionM2BV1 | null
  error: HubSafeErrorV1 | null
  form: PlanDraftForm
  formErrors: string[]

  /** 切换 address 时清空旧投影与临时表单；相同 address 为 no-op。 */
  setAddress: (address: HubAddressV1 | null) => void
  /** 快照刷新（非订阅流）。 */
  refresh: () => Promise<void>
  setForm: (form: PlanDraftForm) => void
  startWithDraft: () => Promise<void>
  /** 原样批准投影携带的 canonical draft（不使用内存表单内容）。 */
  approveActiveRevision: () => Promise<void>
  cancelActiveFlow: (reason?: string) => Promise<boolean>
  clearError: () => void
}

function sameAddress(a: HubAddressV1 | null, b: HubAddressV1 | null): boolean {
  if (!a || !b) return a === b
  return a.projectId === b.projectId && a.sessionKey === b.sessionKey
}

export const useCollaborationHubStore = create<CollaborationHubState>((set, get) => {
  // 请求序号：切换 address / 新 refresh 后，晚到的旧结果一律丢弃
  let requestSeq = 0

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

  return {
    address: null,
    loading: false,
    submitting: false,
    projection: null,
    error: null,
    form: emptyPlanDraftForm(),
    formErrors: [],

    setAddress: (address) => {
      if (sameAddress(get().address, address)) return
      requestSeq += 1
      set({
        address,
        loading: false,
        submitting: false,
        projection: null,
        error: null,
        form: emptyPlanDraftForm(),
        formErrors: [],
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
        set({ loading: false, projection: outcome.value, error: null })
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

    clearError: () => set({ error: null }),
  }
})
