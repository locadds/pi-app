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
 * - XIAOGUI_REPO          小规 Agent 代码仓库根（派生 <repo>/python）
 * - XIAOGUI_ALLOWED_ROOTS 项目根白名单（path.delimiter 分隔）
 *
 * 未显式配置时仅回退到打包资源 process.resourcesPath/xiaogui。
 * 禁止内置开发机绝对路径默认值。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  XIAOGUI_DEFAULT_EXECUTION_PHASE_V1,
  type XiaoguiExecutionPhase,
} from '@shared/xiaogui-prompt-contract'

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
export type ExecutionPhase = XiaoguiExecutionPhase
export { XIAOGUI_DEFAULT_EXECUTION_PHASE_V1 }

const BUNDLED_XIAOGUI_DIR = 'xiaogui'

export type XiaoguiRuntimeSource = 'env-runtime-dir' | 'env-repo' | 'bundled-resource' | 'missing'

export interface XiaoguiRuntimeResolution {
  source: XiaoguiRuntimeSource
  repoRoot: string
  pythonCwd: string | null
  error: string | null
}

export interface XiaoguiBridgeConfig {
  /** 小规 Agent 代码仓库根（DESIGN 扩展源目录派生 / worker env 注入用）。 */
  repoRoot: string
  /** Python 可执行文件。 */
  pythonCommand: string
  /** sidecar 工作目录（需包含 xiaogui_runtime 包）；未配置时为 null。 */
  pythonCwd: string | null
  /** runtime 来源，用于状态呈现、部署清单和诊断。 */
  runtimeSource: XiaoguiRuntimeSource
  /** 未能解析 runtime 时的结构化错误，不在 import 期抛出。 */
  runtimeError: string | null
  /** 项目根白名单；空数组表示不启用（sidecar 侧语义）。 */
  allowedRoots: string[]
  /** 单请求超时（毫秒）。 */
  requestTimeoutMs: number
  /** stop() 等待优雅退出的超时（毫秒）。 */
  shutdownTimeoutMs: number
}

function resourcesPath(): string | null {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath?.trim()
  return value && existsSync(value) ? value : null
}

export function resolveXiaoguiRuntime(): XiaoguiRuntimeResolution {
  const runtimeDir = process.env['XIAOGUI_RUNTIME_DIR']?.trim()
  const repoRootEnv = process.env['XIAOGUI_REPO']?.trim()

  if (runtimeDir) {
    return {
      source: 'env-runtime-dir',
      repoRoot: repoRootEnv || '',
      pythonCwd: runtimeDir,
      error: null,
    }
  }

  if (repoRootEnv) {
    return {
      source: 'env-repo',
      repoRoot: repoRootEnv,
      pythonCwd: path.join(repoRootEnv, 'python'),
      error: null,
    }
  }

  const bundledResourcesPath = resourcesPath()
  const bundledRoot = bundledResourcesPath ? path.join(bundledResourcesPath, BUNDLED_XIAOGUI_DIR) : null
  const bundledPython = bundledRoot ? path.join(bundledRoot, 'python') : null
  if (bundledRoot && bundledPython && existsSync(bundledPython)) {
    return {
      source: 'bundled-resource',
      repoRoot: bundledRoot,
      pythonCwd: bundledPython,
      error: null,
    }
  }

  return {
    source: 'missing',
    repoRoot: '',
    pythonCwd: null,
    error:
      '小规 runtime 未配置：请设置 XIAOGUI_RUNTIME_DIR 或 XIAOGUI_REPO；发布包需包含 resources/xiaogui/python',
  }
}

/** 解析当前生效的 sidecar 配置（环境变量优先）。 */
export function resolveXiaoguiConfig(): XiaoguiBridgeConfig {
  const allowedRoots = (process.env['XIAOGUI_ALLOWED_ROOTS'] ?? '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const runtime = resolveXiaoguiRuntime()
  return {
    repoRoot: runtime.repoRoot,
    pythonCommand: process.env['XIAOGUI_PYTHON']?.trim() || 'python',
    pythonCwd: runtime.pythonCwd,
    runtimeSource: runtime.source,
    runtimeError: runtime.error,
    allowedRoots,
    requestTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
  }
}
