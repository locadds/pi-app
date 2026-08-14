/**
 * 小规 Agent 集成配置（pi-app 主进程侧）。
 *
 * 约束（对应小规仓库 AGENTS.md §6 / §16）：
 * - Python Professional Runtime 以 sidecar 子进程运行，仅 stdio 通信；
 * - 安全边界（项目根白名单）通过 XIAOGUI_ALLOWED_ROOTS 传给 sidecar，
 *   由 sidecar 程序强制执行，不依赖模型自觉。
 *
 * 所有配置均可用环境变量覆盖，便于开发/测试与未来部署调整：
 * - XIAOGUI_PYTHON        Python 可执行文件（默认 'python'）
 * - XIAOGUI_RUNTIME_DIR   sidecar 工作目录（需包含 xiaogui_runtime 包）
 * - XIAOGUI_REPO          小规 Agent 代码仓库根（派生 <repo>/python；
 *                         未设置时回退开发机默认位置）
 * - XIAOGUI_ALLOWED_ROOTS 项目根白名单（path.delimiter 分隔）
 */

import path from 'node:path'

/** 一级工作模式（与小规产品定义一致，禁止使用 PLANNING 命名）。 */
export type XiaoguiMode = 'WORK' | 'DESIGN' | 'CODING'

export interface XiaoguiModeInfo {
  id: XiaoguiMode
  /** 中文标签：WORK｜工作、DESIGN｜规划设计、CODING｜编程 */
  zhLabel: string
}

export const XIAOGUI_MODES: XiaoguiModeInfo[] = [
  { id: 'WORK', zhLabel: '工作' },
  { id: 'DESIGN', zhLabel: '规划设计' },
  { id: 'CODING', zhLabel: '编程' },
]

export function isXiaoguiMode(value: unknown): value is XiaoguiMode {
  return value === 'WORK' || value === 'DESIGN' || value === 'CODING'
}

/**
 * 执行方式（与一级工作模式正交，命名与小规仓库 src/main/xiaogui/types.ts 一致）。
 * V0.1 仅做状态标记与策略路由接口，不实现 Plan Engine。
 */
export type ExecutionPhase = 'ASK' | 'PLAN' | 'EXECUTE'

/**
 * 小规 Agent 代码仓库的开发机默认位置（仅回退用）。
 * 优先读环境变量 XIAOGUI_REPO / XIAOGUI_RUNTIME_DIR；两者都缺失时
 * pythonCwd 为 null，sidecar 启动处返回明确错误（不在 import 期抛异常）。
 */
const DEFAULT_XIAOGUI_REPO = 'd:/工作文件/06AI/小试牛刀/小规agent'

export interface XiaoguiBridgeConfig {
  /** 小规 Agent 代码仓库根（DESIGN 扩展源目录派生 / worker env 注入用）。 */
  repoRoot: string
  /** Python 可执行文件。 */
  pythonCommand: string
  /** sidecar 工作目录（需包含 xiaogui_runtime 包）；未配置时为 null。 */
  pythonCwd: string | null
  /** 项目根白名单；空数组表示不启用（sidecar 侧语义）。 */
  allowedRoots: string[]
  /** 单请求超时（毫秒）。 */
  requestTimeoutMs: number
  /** stop() 等待优雅退出的超时（毫秒）。 */
  shutdownTimeoutMs: number
}

/** 解析当前生效的 sidecar 配置（环境变量优先）。 */
export function resolveXiaoguiConfig(): XiaoguiBridgeConfig {
  const allowedRoots = (process.env['XIAOGUI_ALLOWED_ROOTS'] ?? '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const runtimeDir = process.env['XIAOGUI_RUNTIME_DIR']?.trim()
  const repoRoot = process.env['XIAOGUI_REPO']?.trim() || DEFAULT_XIAOGUI_REPO
  return {
    repoRoot,
    pythonCommand: process.env['XIAOGUI_PYTHON']?.trim() || 'python',
    pythonCwd: runtimeDir || (repoRoot ? path.join(repoRoot, 'python') : null),
    allowedRoots,
    requestTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
  }
}
