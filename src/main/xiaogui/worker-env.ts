/**
 * 小规 worker env 构造（pi-app 主进程 → utilityProcess worker 注入）。
 *
 * 独立成无 electron 依赖的纯函数模块，便于单测：
 * - XIAOGUI_RUNTIME_DIR / XIAOGUI_REPO / XIAOGUI_PYTHON：定位 Python sidecar；
 * - XIAOGUI_PHASE：执行方式（ASK/PLAN/EXECUTE），由调用方从 sidecar-bridge
 *   单例读取、fork 时取当时值固化；切换后由 ipc:xiaogui.phase.switch
 *   重启 worker 使新 env 生效；
 * - XIAOGUI_PHASE_GUARD：安全护栏灰度开关，默认不设置（=关闭），
 *   显式配置时透传。
 */
import { resolveXiaoguiConfig } from './config'

export interface XiaoguiWorkerEnvOptions {
  /** 当前执行方式（fork 时取当时值，由 sidecar-bridge 单例提供）。 */
  executionPhase: string
  /** host env（默认 process.env；XIAOGUI_PHASE_GUARD 透传来源）。 */
  hostEnv?: NodeJS.ProcessEnv
}

/** 构造注入 worker 的小规 env（配置异常时返回空对象，静默跳过）。 */
export function buildXiaoguiWorkerEnv(opts: XiaoguiWorkerEnvOptions): Record<string, string> {
  try {
    const cfg = resolveXiaoguiConfig()
    const env: Record<string, string> = {
      XIAOGUI_RUNTIME_DIR: cfg.pythonCwd || '',
      XIAOGUI_REPO: cfg.repoRoot || '',
      XIAOGUI_PYTHON: cfg.pythonCommand || 'python',
      XIAOGUI_PHASE: opts.executionPhase,
    }
    const phaseGuard = (opts.hostEnv ?? process.env)['XIAOGUI_PHASE_GUARD']?.trim()
    if (phaseGuard) env['XIAOGUI_PHASE_GUARD'] = phaseGuard
    return env
  } catch {
    return {}
  }
}