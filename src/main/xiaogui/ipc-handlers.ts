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

export function registerXiaoguiHandlers(): void {
  registerHandlerWithSchema('ipc:xiaogui.mode.switch', ModeSwitchSchema, async (req) => {
    const mode = xiaogui.setMode(req.mode as XiaoguiMode)
    return { ok: true, mode }
  })

  registerHandler('ipc:xiaogui.mode.get', async () => {
    return { mode: xiaogui.getMode() }
  })

  // ---- 执行方式（ASK/PLAN/EXECUTE，与一级模式正交；V0.1 仅状态标记，不拦截行为） ----

  registerHandlerWithSchema('ipc:xiaogui.phase.switch', PhaseSwitchSchema, async (req) => {
    const phase = xiaogui.setExecutionPhase(req.phase as ExecutionPhase)
    // 执行方式经 worker env（XIAOGUI_PHASE）注入、fork 时固化：切换成功后重启
    // 当前项目 worker 使新 phase 生效（遵循 scope.set 打标 DESIGN 的既有生命周期
    // 模式）；worker busy 时不打断在途会话，重启失败仅记录、不阻断切换本身
    if (workerManager.cwd && !workerManager.hasActiveTurns) {
      try {
        await workerManager.stop()
        await workerManager.start(workerManager.cwd)
      } catch (e) {
        console.warn('[xiaogui] phase 切换后 worker 重启失败:', e)
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
