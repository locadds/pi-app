/**
 * 小规相关 IPC handlers（注册进 pi-app ipc/registry，channel 均加入
 * packages/shared/ipc-channels.ts 白名单）。
 *
 * 通道约定（渲染进程经 ipcClient.invoke('xiaogui.*') 调用）：
 * - ipc:xiaogui.mode.switch     切换一级模式（WORK/DESIGN/CODING）
 * - ipc:xiaogui.mode.get        获取当前模式
 * - ipc:xiaogui.phase.switch    切换执行方式（ASK/PLAN/EXECUTE）
 * - ipc:xiaogui.phase.get       获取当前执行方式
 * - ipc:xiaogui.tool.invoke     调用 DESIGN Tool（name/action/params）
 * - ipc:xiaogui.sidecar.status  sidecar 运行状态
 * - ipc:xiaogui.scope.get       查询会话/项目的模式归属（查不到=历史数据）
 * - ipc:xiaogui.scope.set       写入会话/项目的模式映射（ifAbsent 可选）
 * - ipc:xiaogui.scope.list      拉取全量映射（渲染层过滤侧栏列表用）
 * - ipc:xiaogui.guard.status    企业安全护栏只读状态（部署/启用/写入根/审计）
 */

import { BrowserWindow } from 'electron'
import { z } from 'zod'

import { registerHandler, registerHandlerWithSchema } from '../ipc/registry'
import { workerManager } from '../worker-manager'
import { configStore } from '../config-store'
import { xiaogui, type ToolInvokePayload } from './sidecar-bridge'
import { getProjectBaseline, getScope, listScopes, recordProjectBaseline, setScope, type ScopeKind } from './scope-store'
import { readGuardStatus } from './guard-status'
import { ensureDesignExtensionDeployed } from './design-extension-deploy'
import type { ExecutionPhase, XiaoguiMode } from './config'
import { sessionScopeResolverV1 } from './scope-service'
import { getDefaultWorkDocxTemplateIntakeServiceV1 } from './work-docx-template-intake-composition'
import { readSessionMetaFromFile } from '../session-file-meta'
import { normalizeSessionKey } from '../worker-session-key'
import { requestDirectExtensionUI } from '../direct-extension-ui'
import { currentVisibleSessionFile } from '../completion-notification-events'
import { summarizeTemplateReviewActionsV2 } from '@shared/xiaogui-template-review-decisions'
import { errorMessage } from '@shared/error-message'

const ModeSwitchSchema = z.object({
  mode: z.enum(['WORK', 'DESIGN', 'CODING']),
})

const PhaseSwitchSchema = z.object({
  phase: z.enum(['ASK', 'PLAN', 'EXECUTE']),
})

const ScopeKindSchema = z.enum(['session', 'project'])

const ScopeGetSchema = z.object({
  kind: ScopeKindSchema,
  key: z.string().min(1),
})

const ScopeSetSchema = z.object({
  kind: ScopeKindSchema,
  key: z.string().min(1),
  mode: z.enum(['WORK', 'DESIGN', 'CODING']),
  ifAbsent: z.boolean().optional(),
})

const ScopeBaselineProjectsSchema = z.object({
  paths: z.array(z.string()),
})

const CanonicalScopeLookupSchema = z.object({
  projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
  sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
})

const ToolInvokeSchema = z.object({
  tool: z.string().min(1),
  action: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  trace_id: z.string().optional(),
})

const DirectTemplateReviewOpenSchema = z.object({
  sessionFile: z.string().trim().min(1).max(4_096),
  reportId: z.string().trim().min(1).max(160),
})

const DirectReviewRangeSchema = z
  .object({
    startUtf16: z.number().int().nonnegative(),
    endUtf16Exclusive: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.endUtf16Exclusive > range.startUtf16)
const DirectReviewActionBase = {
  targetId: z.string().min(1).max(160),
  range: DirectReviewRangeSchema.optional(),
  highRiskOverrideReason: z.string().trim().min(1).max(1_000).optional(),
  highRiskOverrideConfirmed: z.literal(true).optional(),
}
const DirectReviewActionSchema = z.discriminatedUnion('kind', [
  z.object({ ...DirectReviewActionBase, kind: z.literal('KEEP') }).strict(),
  z.object({ ...DirectReviewActionBase, kind: z.literal('REMOVE') }).strict(),
  z.object({ ...DirectReviewActionBase, kind: z.literal('REPLACE_TEXT'), replacementText: z.string().max(20_000) }).strict(),
  z.object({ ...DirectReviewActionBase, kind: z.literal('FIELD'), fieldName: z.string().trim().min(1).max(120) }).strict(),
  z.object({ ...DirectReviewActionBase, kind: z.literal('REPLACE_IMAGE'), replacementImageToken: z.string().min(1).max(240) }).strict(),
  z.object({ ...DirectReviewActionBase, kind: z.literal('REPEAT'), blockName: z.string().trim().min(1).max(120) }).strict(),
  z.object({ ...DirectReviewActionBase, kind: z.literal('CONDITIONAL'), conditionName: z.string().trim().min(1).max(120) }).strict(),
])
const DirectReviewIssueChoiceSchema = z.object({
  issueId: z.string().min(1).max(160),
  action: z.enum([
    'ACCEPT_SUGGESTION',
    'KEEP_ORIGINAL',
    'REMOVE_CONTENT',
    'OPEN_ADVANCED_REVIEW',
    'RETRY_ANALYSIS',
  ]),
  reason: z.string().trim().min(1).max(1_000).optional(),
}).strict()
const DirectReviewResultSchema = z.discriminatedUnion('cancelled', [
  z.object({ cancelled: z.literal(true), draftActions: z.array(DirectReviewActionSchema).max(400) }).strict(),
  z.object({
    cancelled: z.literal(false),
    actions: z.array(DirectReviewActionSchema).max(400),
    issueChoicesV2: z.array(DirectReviewIssueChoiceSchema).max(400).optional(),
    confirmedAtLocal: z.string().min(1).max(80),
    confirmedBy: z.literal('LOCAL_USER'),
  }).strict(),
])

const directTemplateReviewScopes = new Set<string>()

function directReviewFailure(code: string): { ok: false; code: string; message: string } {
  const message = code === 'TEMPLATE_INTAKE_SOURCE_CHANGED'
    ? '源文档已经变化，请重新分析后再复核'
    : code === 'TEMPLATE_INTAKE_REPORT_NOT_FOUND'
      ? '这份候选报告已不是当前报告，请刷新会话后重试'
      : code === 'TEMPLATE_INTAKE_OPERATION_ACTIVE'
        ? '当前报告正在复核，请先完成或关闭现有复核界面'
        : '暂时无法打开文档复核，请稍后重试'
  return { ok: false, code, message }
}

export function registerXiaoguiHandlers(): void {
  registerHandlerWithSchema('ipc:xiaogui.mode.switch', ModeSwitchSchema, async (req) => {
    const mode = xiaogui.setMode(req.mode as XiaoguiMode)
    return { ok: true, mode }
  })

  registerHandler('ipc:xiaogui.mode.get', async () => {
    return { mode: xiaogui.getMode() }
  })

  // ---- 执行方式（ASK/PLAN/EXECUTE，与一级模式正交；仅在空闲 Worker 上切换） ----

  registerHandlerWithSchema('ipc:xiaogui.phase.switch', PhaseSwitchSchema, async (req) => {
    if (workerManager.hasActiveTurns) {
      throw new Error('XIAOGUI_PHASE_SWITCH_TURN_ACTIVE')
    }
    const previousPhase = xiaogui.getExecutionPhase()
    const phase = xiaogui.setExecutionPhase(req.phase as ExecutionPhase)
    const cwd = workerManager.cwd
    if (cwd) {
      try {
        await workerManager.stop()
        await workerManager.start(cwd)
      } catch (error) {
        xiaogui.setExecutionPhase(previousPhase)
        try {
          await workerManager.stop()
          await workerManager.start(cwd)
        } catch {
          // Phase is rolled back even if Worker recovery also fails. The caller
          // receives an explicit failure instead of observing false success.
        }
        throw new Error(`XIAOGUI_PHASE_WORKER_REBUILD_FAILED: ${errorMessage(error)}`)
      }
    }
    return { ok: true, phase }
  })

  registerHandler('ipc:xiaogui.phase.get', async () => {
    return { phase: xiaogui.getExecutionPhase() }
  })

  registerHandlerWithSchema('ipc:xiaogui.tool.invoke', ToolInvokeSchema, async (req) => {
    // 安全默认：把 allowedRoots 收敛为当前项目根（workerManager.cwd → 激活项目），
    // 显式配置 XIAOGUI_ALLOWED_ROOTS 仅作追加（配置 ∪ 当前项目根，向后兼容）
    const projectRoot = workerManager.cwd || configStore.get('currentProject') || null
    const result = await xiaogui.invokeTool(req as ToolInvokePayload, { projectRoot })
    return { ok: true, result }
  })

  registerHandler('ipc:xiaogui.sidecar.status', async () => {
    return xiaogui.status()
  })

  registerHandlerWithSchema(
    'ipc:xiaogui.work.template-intake.review.open',
    DirectTemplateReviewOpenSchema,
    async (req) => {
      const targetWindow = BrowserWindow.getFocusedWindow()
        ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
      if (!targetWindow || targetWindow.isDestroyed()) {
        return directReviewFailure('TEMPLATE_INTAKE_REVIEW_WINDOW_UNAVAILABLE')
      }

      const requestedSessionFile = normalizeSessionKey(req.sessionFile)
      const visibleSessionFile = normalizeSessionKey(currentVisibleSessionFile() ?? '')
      if (!requestedSessionFile || requestedSessionFile !== visibleSessionFile) {
        return directReviewFailure('SESSION_SCOPE_MISMATCH')
      }
      const cwd = readSessionMetaFromFile(requestedSessionFile)?.cwd
      if (!cwd) return directReviewFailure('SESSION_NOT_READY')
      const scope = await sessionScopeResolverV1.resolveExisting({
        rootPath: cwd,
        sessionFile: requestedSessionFile,
      })
      if (!scope || scope.sessionMode !== 'WORK') {
        return directReviewFailure('TEMPLATE_INTAKE_MODE_NOT_ALLOWED')
      }

      const address = { projectId: scope.projectId, sessionKey: scope.sessionKey }
      const scopeKey = `${scope.projectId}\0${scope.sessionKey}`
      if (directTemplateReviewScopes.has(scopeKey)) {
        return directReviewFailure('TEMPLATE_INTAKE_OPERATION_ACTIVE')
      }
      directTemplateReviewScopes.add(scopeKey)

      const service = getDefaultWorkDocxTemplateIntakeServiceV1()
      const common = {
        sourceSessionId: 'renderer-direct-review',
        sourceRunId: `renderer-direct-review-${Date.now()}`,
        toolCallId: `renderer-direct-review-${req.reportId}`,
      }
      try {
        const opened = await service.execute(address, {
          ...common,
          action: 'REVIEW',
          reportId: req.reportId,
        })
        if (!opened.ok) return directReviewFailure(opened.error.code)
        if (opened.value.kind === 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED') {
          return { ok: true, state: 'CONFIRMED' as const }
        }
        if (
          opened.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_REVIEW_REQUIRED' ||
          (!opened.value.templateDraftRequestV2 && !opened.value.reviewRequestV3 && !opened.value.reviewRequestV2)
        ) {
          return directReviewFailure('TEMPLATE_INTAKE_REVIEW_UNAVAILABLE')
        }

        const report = opened.value.report
        const response = await requestDirectExtensionUI(targetWindow, {
          method: 'custom',
          kind: 'template_intake_review',
          payload: opened.value.templateDraftRequestV2 ?? opened.value.reviewRequestV3 ?? opened.value.reviewRequestV2,
          toolCallId: common.toolCallId,
        })
        if (response.cancelled) return { ok: true, state: 'CANCELLED' as const }
        const reviewed = DirectReviewResultSchema.safeParse(response.result)
        if (!reviewed.success) return directReviewFailure('TEMPLATE_INTAKE_REVIEW_RESULT_INVALID')

        if (reviewed.data.cancelled) {
          const draftActions = reviewed.data.draftActions
          if (draftActions.length > 0) {
            const decisions = summarizeTemplateReviewActionsV2(report, draftActions)
            const saved = await service.execute(address, {
              ...common,
              action: 'UPDATE',
              reportId: req.reportId,
              operations: decisions.map((item) => ({
                candidateIds: [item.candidateId],
                decision: item.decision,
                ...(item.fieldName ? { fieldName: item.fieldName } : {}),
                ...(item.highRiskOverrideReason ? { reason: item.highRiskOverrideReason } : {}),
                reviewActionsV2: draftActions.filter(
                  (action) => action.targetId === item.candidateId,
                ),
              })),
            })
            if (!saved.ok) return directReviewFailure(saved.error.code)
          }
          return { ok: true, state: 'CANCELLED' as const }
        }

        const confirmed = await service.execute(address, {
          ...common,
          action: 'REVIEW',
          reportId: req.reportId,
          submission: {
            decisions: summarizeTemplateReviewActionsV2(report, reviewed.data.actions),
            reviewActionsV2: reviewed.data.actions,
            ...(reviewed.data.issueChoicesV2
              ? { issueChoicesV2: reviewed.data.issueChoicesV2 }
              : {}),
          },
        })
        if (!confirmed.ok) return directReviewFailure(confirmed.error.code)
        if (confirmed.value.kind !== 'XIAOGUI_WORK_DOCX_TEMPLATE_INTAKE_CONFIRMED') {
          return directReviewFailure('TEMPLATE_INTAKE_REVIEW_RESULT_INVALID')
        }
        return { ok: true, state: 'CONFIRMED' as const }
      } finally {
        directTemplateReviewScopes.delete(scopeKey)
      }
    },
  )

  // ---- 企业安全护栏状态（只读 FS/env 探测，不执行任何项目代码） ----

  registerHandler('ipc:xiaogui.guard.status', async (payload) => {
    const workspacePath =
      (typeof payload?.workspacePath === 'string' && payload.workspacePath) ||
      workerManager.cwd ||
      configStore.get('currentProject')
    if (!workspacePath) return null
    return readGuardStatus(workspacePath)
  })

  // ---- 模式作用域映射（三模式独立对话/项目；查不到映射=历史数据，渲染层按 WORK 处理） ----

  registerHandlerWithSchema('ipc:xiaogui.scope.lookup', CanonicalScopeLookupSchema, async (req) => {
    return sessionScopeResolverV1.lookup({
      projectId: req.projectId as never,
      sessionKey: req.sessionKey as never,
    })
  })

  registerHandlerWithSchema('ipc:xiaogui.scope.get', ScopeGetSchema, async (req) => {
    return { mode: getScope(req.kind as ScopeKind, req.key) }
  })

  registerHandlerWithSchema('ipc:xiaogui.scope.set', ScopeSetSchema, async (req) => {
    const mode = setScope(req.kind as ScopeKind, req.key, req.mode as XiaoguiMode, {
      ifAbsent: req.ifAbsent === true,
    })
    // 首次打标为 DESIGN 时部署扩展；worker 非 busy 则重启以加载
    if (req.kind === 'project' && req.mode === 'DESIGN') {
      const deployed = await ensureDesignExtensionDeployed(req.key).catch(() => false)
      if (deployed && workerManager.cwd === req.key && !workerManager.hasActiveTurns) {
        await workerManager.stop().catch(() => {})
        await workerManager.start(req.key).catch(() => {})
      }
    }
    return { ok: true, mode }
  })

  registerHandler('ipc:xiaogui.scope.list', async () => {
    return listScopes()
  })

  // 项目基线：功能上线时的存量 recentProjects 归 WORK 不打标签（历史归 WORK）
  registerHandlerWithSchema('ipc:xiaogui.scope.baselineProjects', ScopeBaselineProjectsSchema, async (req) => {
    return { ok: true, baseline: getProjectBaseline(), recorded: recordProjectBaseline(req.paths) }
  })
}
