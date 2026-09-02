/**
 * 小规 sidecar 桥接（pi-app 内精简版）。
 *
 * 两个仓库分开维护，不使用 symlink：这里内联实现与小规仓库
 * src/main/xiaogui/sidecar-manager.ts + tool-gateway.ts 相同协议的精简版本：
 * - spawn `python -m xiaogui_runtime`（newline-delimited JSON-RPC 2.0 over stdio）；
 * - stdout 只承载协议消息，stderr 视为日志；
 * - 每个请求携带 trace_id（UUID v4），贯穿调用链；
 * - tool.invoke 路由与小规 ToolGateway 语义一致（永远返回 ToolResult，
 *   不向渲染进程抛业务异常）。
 *
 * 安全边界：渲染进程不直接接触本模块；所有调用经 IPC 白名单通道进入主进程。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  resolveXiaoguiConfig,
  isXiaoguiMode,
  XIAOGUI_DEFAULT_EXECUTION_PHASE_V1,
  type ExecutionPhase,
  type XiaoguiBridgeConfig,
  type XiaoguiMode,
} from './config'
import { loadPersistedMode, persistMode } from './scope-store'

// ---------------------------------------------------------------------------
// ToolResult 统一返回结构（与小规仓库 types.ts / Python ToolResult.to_dict 一致）
// ---------------------------------------------------------------------------

export type ToolStatus = 'ok' | 'warning' | 'error'

export interface Evidence {
  source_type: string
  source_path?: string
  location?: string
  object_id?: string
  excerpt?: string
  hash?: string
  metadata?: Record<string, unknown>
}

export interface ToolResult {
  status: ToolStatus
  data: Record<string, unknown>
  evidence: Evidence[]
  warnings: string[]
  source_version: string
  generated_at: string
  trace_id: string
}

/** pi-app 侧桥接产生的 ToolResult 的 source_version 标识。 */
export const BRIDGE_SOURCE_VERSION = 'xiaogui-pi-app-bridge/v1'

const DESIGN_PROJECT_TOOL = 'design.project'
const RPC_METHOD_INSPECT = 'design.project.inspect'
const RPC_METHOD_OPEN = 'design.project.open'
const RPC_METHOD_CAPABILITIES = 'design.project.capabilities'
const RPC_METHOD_INITIALIZE = 'runtime.initialize'
const RPC_METHOD_SHUTDOWN = 'runtime.shutdown'

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

class SidecarBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SidecarBridgeError'
  }
}

class SidecarRpcError extends SidecarBridgeError {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'SidecarRpcError'
    this.code = code
    this.data = data
  }
}

class SidecarTimeoutError extends SidecarBridgeError {
  constructor(method: string, timeoutMs: number, traceId: string) {
    super(`sidecar 请求超时: method=${method} timeout=${timeoutMs}ms trace_id=${traceId}`)
    this.name = 'SidecarTimeoutError'
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

// ---------------------------------------------------------------------------
// ToolResult 构造辅助
// ---------------------------------------------------------------------------

function errorToolResult(traceId: string, message: string): ToolResult {
  return {
    status: 'error',
    data: {},
    evidence: [],
    warnings: [message],
    source_version: BRIDGE_SOURCE_VERSION,
    generated_at: new Date().toISOString(),
    trace_id: traceId,
  }
}

/** 已符合 ToolResult 形态的原样透传；否则包装进 data.result。 */
function normalizeToolResult(raw: unknown, traceId: string): ToolResult {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    typeof (raw as ToolResult).status === 'string' &&
    'trace_id' in (raw as Record<string, unknown>)
  ) {
    return raw as ToolResult
  }
  return {
    status: 'ok',
    data: { result: raw },
    evidence: [],
    warnings: [],
    source_version: BRIDGE_SOURCE_VERSION,
    generated_at: new Date().toISOString(),
    trace_id: traceId,
  }
}

// ---------------------------------------------------------------------------
// 集成门面（单例）
// ---------------------------------------------------------------------------

export interface XiaoguiStatus {
  running: boolean
  mode: XiaoguiMode
  pythonCommand: string
  pythonCwd: string | null
  runtimeSource: XiaoguiBridgeConfig['runtimeSource']
  activeAllowedRoots: string[]
  lastError: string | null
  pendingRequests: number
}

export interface ToolInvokePayload {
  tool: string
  action: string
  params?: Record<string, unknown>
  trace_id?: string
}

export interface SidecarIdentity {
  key: string
  runtimeDir: string
  allowedRoots: string[]
}

export type SidecarLifecycleDecision = 'reuse' | 'start' | 'restart' | 'await-starting' | 'reject'

/**
 * 计算实际生效的项目根白名单：显式配置 ∪ 当前项目根（去空、去重、保序）。
 * 安全默认：未显式配置 XIAOGUI_ALLOWED_ROOTS 时收敛为仅当前项目根，
 * 避免渲染层经 tool.invoke 间接 inspect 任意目录（sidecar 侧强制执行白名单）。
 */
export function resolveAllowedRoots(
  configRoots: ReadonlyArray<string>,
  projectRoot?: string | null,
): string[] {
  const trimmedProject = projectRoot?.trim() ?? ''
  const merged = [...configRoots, ...(trimmedProject.length > 0 ? [trimmedProject] : [])]
  return [...new Set(merged.map((p) => p.trim()).filter((p) => p.length > 0))]
}

export function resolveSidecarIdentity(
  config: Pick<XiaoguiBridgeConfig, 'pythonCwd' | 'runtimeError' | 'allowedRoots'>,
  projectRoot?: string | null,
): { ok: true; identity: SidecarIdentity } | { ok: false; error: string } {
  if (!config.pythonCwd) {
    return {
      ok: false,
      error:
        config.runtimeError ||
        'sidecar 工作目录未配置：请设置 XIAOGUI_REPO 或 XIAOGUI_RUNTIME_DIR，或使用包含 resources/xiaogui/python 的发布包',
    }
  }

  const roots = resolveAllowedRoots(config.allowedRoots, projectRoot)
  if (roots.length === 0) {
    return {
      ok: false,
      error: '项目工具已拒绝执行：当前没有项目根或 XIAOGUI_ALLOWED_ROOTS 白名单，不能以空白名单启动 sidecar',
    }
  }

  return {
    ok: true,
    identity: {
      key: JSON.stringify({ runtimeDir: config.pythonCwd, allowedRoots: roots }),
      runtimeDir: config.pythonCwd,
      allowedRoots: roots,
    },
  }
}

export function planSidecarLifecycle(params: {
  running: boolean
  activeIdentityKey: string | null
  nextIdentityKey: string
  pendingRequests: number
  startingIdentityKey?: string | null
  shuttingDown?: boolean
}): SidecarLifecycleDecision {
  if (params.shuttingDown) return 'reject'
  if (params.startingIdentityKey) {
    return params.startingIdentityKey === params.nextIdentityKey ? 'await-starting' : 'reject'
  }
  if (!params.running) return 'start'
  if (params.activeIdentityKey === params.nextIdentityKey) return 'reuse'
  if (params.pendingRequests > 0) return 'reject'
  return 'restart'
}

/**
 * 构造 sidecar 子进程 env（纯函数，便于单测）：
 * 白名单 = 显式配置 ∪ 当前项目根；其余约定与旧 buildEnv 一致。
 */
export function buildSidecarEnv(
  base: NodeJS.ProcessEnv,
  config: { allowedRoots: ReadonlyArray<string>; requestTimeoutMs: number },
  projectRoot?: string | null,
  effectiveAllowedRoots?: ReadonlyArray<string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const roots = effectiveAllowedRoots ?? resolveAllowedRoots(config.allowedRoots, projectRoot)
  env['XIAOGUI_ALLOWED_ROOTS'] = roots.join(path.delimiter)
  env['XIAOGUI_REQUEST_TIMEOUT'] = String(Math.ceil(config.requestTimeoutMs / 1000))
  return env
}

export interface XiaoguiIntegrationDeps {
  config?: XiaoguiBridgeConfig
  mode?: XiaoguiMode
  spawnSidecar?: (
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => ChildProcessWithoutNullStreams
}

export interface XiaoguiIntegrationTestInstance {
  getExecutionPhase(): ExecutionPhase
  status(): XiaoguiStatus
  shutdown(): Promise<void>
  invokeTool(payload: ToolInvokePayload, opts?: { projectRoot?: string | null }): Promise<ToolResult>
}

/**
 * 小规集成门面：持有当前一级模式与 sidecar 生命周期。
 * sidecar 采用惰性启动（首次 tool.invoke 时 spawn），避免拖慢应用启动。
 */
class XiaoguiIntegration {
  private readonly config: XiaoguiBridgeConfig
  private readonly spawnSidecar: NonNullable<XiaoguiIntegrationDeps['spawnSidecar']>
  // 一级模式持久化在 xiaogui.json（scope-store），重启后恢复上次模式
  private mode: XiaoguiMode
  // 执行方式（ASK/PLAN/EXECUTE，与一级模式正交）。默认允许受控执行；
  // ASK / PLAN 仅在用户明确选择时启用，安全仍由工具、权限和交付门强制。
  private executionPhase: ExecutionPhase = XIAOGUI_DEFAULT_EXECUTION_PHASE_V1
  // 当前项目根（IPC handler 在 tool.invoke 时传入）：sidecar 尚未启动时并入
  // XIAOGUI_ALLOWED_ROOTS（安全默认收敛）；已启动进程不重写 env，重启后生效
  private projectRoot: string | null = null
  private activeIdentity: SidecarIdentity | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number | string, PendingRequest>()
  private nextId = 1
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private running = false
  private shuttingDown = false
  private starting: Promise<void> | null = null
  private startingIdentity: SidecarIdentity | null = null
  private cancelStarting: ((error: Error) => void) | null = null
  private startingCanceled = false
  private lastError: string | null = null

  constructor(deps: XiaoguiIntegrationDeps = {}) {
    this.config = deps.config ?? resolveXiaoguiConfig()
    this.spawnSidecar =
      deps.spawnSidecar ??
      ((command, args, options) =>
        spawn(command, args, options) as ChildProcessWithoutNullStreams)
    this.mode = deps.mode ?? loadPersistedMode()
  }

  // ---- 模式 ---------------------------------------------------------------

  getMode(): XiaoguiMode {
    return this.mode
  }

  setMode(mode: XiaoguiMode): XiaoguiMode {
    this.mode = mode
    persistMode(mode)
    return this.mode
  }

  getExecutionPhase(): ExecutionPhase {
    return this.executionPhase
  }

  setExecutionPhase(phase: ExecutionPhase): ExecutionPhase {
    this.executionPhase = phase
    return this.executionPhase
  }

  // ---- 状态 ---------------------------------------------------------------

  status(): XiaoguiStatus {
    return {
      running: this.isRunning(),
      mode: this.mode,
      pythonCommand: this.config.pythonCommand,
      pythonCwd: this.config.pythonCwd,
      runtimeSource: this.config.runtimeSource,
      activeAllowedRoots: this.activeIdentity?.allowedRoots ?? [],
      lastError: this.lastError,
      pendingRequests: this.pending.size,
    }
  }

  private isRunning(): boolean {
    return this.running && this.child !== null && this.child.exitCode === null
  }

  // ---- sidecar 生命周期 ----------------------------------------------------

  /** 确保 sidecar 已启动并完成 initialize 握手（并发调用共享同一 Promise）。 */
  private async ensureStarted(identity: SidecarIdentity): Promise<void> {
    const decision = planSidecarLifecycle({
      running: this.isRunning(),
      activeIdentityKey: this.activeIdentity?.key ?? null,
      nextIdentityKey: identity.key,
      pendingRequests: this.pending.size,
      startingIdentityKey: this.starting ? this.startingIdentity?.key ?? null : null,
      shuttingDown: this.shuttingDown,
    })

    if (decision === 'reuse') return
    if (decision === 'await-starting') return this.starting!
    if (decision === 'reject') {
      throw new SidecarBridgeError('sidecar 白名单/运行时正在切换；本次项目工具调用已拒绝，请稍后重试')
    }
    if (decision === 'restart') {
      await this.shutdown()
    }

    this.startingIdentity = identity
    this.starting = this.doStart(identity).finally(() => {
      this.starting = null
      this.startingIdentity = null
      this.cancelStarting = null
      this.startingCanceled = false
    })
    return this.starting
  }

  private async doStart(identity: SidecarIdentity): Promise<void> {
    const { pythonCommand } = this.config
    const env = this.buildEnv(identity)

    const child = this.spawnSidecar(pythonCommand, ['-m', 'xiaogui_runtime'], {
      cwd: identity.runtimeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    })

    this.child = child
    this.activeIdentity = identity
    this.shuttingDown = false
    this.startingCanceled = false
    this.stdoutBuffer = ''
    this.stderrBuffer = ''

    try {
      await new Promise<void>((resolve, reject) => {
        this.cancelStarting = (error) => {
          this.startingCanceled = true
          reject(error)
        }
        child.once('spawn', () => {
          if (this.child !== child || this.startingCanceled) {
            this.killChild(child, 'sidecar 启动取消后迟到 spawn kill 失败')
            return
          }
          resolve()
        })
        child.once('error', (err) => {
          reject(new SidecarBridgeError(`sidecar 启动失败（command=${pythonCommand}）: ${err.message}`))
        })
      })
    } catch (err) {
      if (this.child === child) {
        this.child = null
        this.activeIdentity = null
      }
      this.lastError = err instanceof Error ? err.message : String(err)
      throw err
    }

    if (this.startingCanceled || this.child !== child) {
      const err = 'sidecar 启动已被 shutdown 取消'
      if (this.child === child) {
        this.child = null
        this.activeIdentity = null
      }
      this.lastError = err
      throw new SidecarBridgeError(err)
    }

    this.running = true
    // 若在 spawn 与 running=true 之间 sidecar 已退出，应把启动视为失败；
    // 但只能清理当前 child，避免旧 child 的迟到状态污染新进程。
    if (!this.isRunning()) {
      const err = this.lastError || `sidecar 启动后立刻退出（code=${child.exitCode ?? 'null'}）`
      if (this.child === child) {
        this.running = false
        this.child = null
        this.activeIdentity = null
      }
      this.lastError = err
      throw new SidecarBridgeError(err)
    }
    this.lastError = null

    child.stdin.on('error', () => undefined)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child === child) this.onStdout(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      if (this.child === child) this.onStderr(chunk)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.running = false
      this.failAllPending(
        new SidecarBridgeError(`sidecar 进程已退出（code=${code} signal=${signal ?? 'null'}）`),
      )
      if (!this.shuttingDown) {
        console.warn(`[xiaogui] sidecar 非预期退出 code=${code} signal=${signal ?? 'null'}`)
        this.lastError = `sidecar 非预期退出（code=${code ?? 'null'}）`
      }
      this.child = null
      this.activeIdentity = null
    })

    // 握手：runtime.initialize（失败不阻断，仅记录；inspect 仍可重试）
    try {
      await this.call(RPC_METHOD_INITIALIZE, {})
    } catch (err) {
      this.lastError = `sidecar initialize 失败: ${err instanceof Error ? err.message : String(err)}`
      console.warn(`[xiaogui] ${this.lastError}`)
    }
  }

  /** 优雅停止：runtime.shutdown + 等待退出，超时 kill。退出 app 时调用。 */
  async shutdown(): Promise<void> {
    const child = this.child
    const starting = this.starting
    if (this.starting && !this.running) {
      this.shuttingDown = true
      this.startingCanceled = true
      this.cancelStarting?.(new SidecarBridgeError('sidecar 启动已被 shutdown 取消'))
      if (child) this.killChild(child, 'sidecar 启动取消 kill 失败')
      await starting?.catch(() => undefined)
      if (this.child === child) {
        this.running = false
        this.child = null
        this.activeIdentity = null
      }
      this.shuttingDown = false
      return
    }
    if (!this.isRunning() || !child) {
      this.running = false
      this.activeIdentity = null
      this.shuttingDown = false
      return
    }
    this.shuttingDown = true
    try {
      await this.call(RPC_METHOD_SHUTDOWN, {}, { timeoutMs: this.config.shutdownTimeoutMs })
    } catch {
      /* 走强制路径 */
    }
    await new Promise<void>((resolve) => {
      if (!this.running) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        if (this.running && this.child) this.killChild(this.child, 'sidecar shutdown kill 失败')
        resolve()
      }, this.config.shutdownTimeoutMs)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    if (this.child === child) {
      this.failAllPending(new SidecarBridgeError('sidecar 正在关闭，未完成请求已取消'))
      this.running = false
      this.child = null
      this.activeIdentity = null
    }
    await starting?.catch(() => undefined)
    this.shuttingDown = false
  }

  // ---- Tool 调用（与 ToolGateway 语义一致）----------------------------------

  /**
   * 执行一次 tool call，永远返回 ToolResult（不抛业务异常）。
   * V0.1 仅注册 design.project（inspect / open / capabilities 均真正打通）。
   */
  async invokeTool(
    payload: ToolInvokePayload,
    opts?: { projectRoot?: string | null },
  ): Promise<ToolResult> {
    // 记录当前项目根（未显式配置白名单时的安全默认收敛，见 buildSidecarEnv）
    if (opts) {
      this.projectRoot = opts.projectRoot?.trim() || null
    }
    const traceId = payload.trace_id?.trim() || randomUUID()
    const { tool, action } = payload
    const params = payload.params ?? {}

    if (tool !== DESIGN_PROJECT_TOOL) {
      return errorToolResult(
        traceId,
        `未注册的 tool: ${tool}（V0.1 已注册: ${DESIGN_PROJECT_TOOL}）`,
      )
    }

    if (!['inspect', 'open', 'capabilities'].includes(action)) {
      return errorToolResult(
        traceId,
        `design.project 不支持 action: ${action}（可用: inspect, open, capabilities）`,
      )
    }

    const rpcMethod =
      action === 'open'
        ? RPC_METHOD_OPEN
        : action === 'capabilities'
          ? RPC_METHOD_CAPABILITIES
          : RPC_METHOD_INSPECT

    try {
      const identity = resolveSidecarIdentity(this.config, this.projectRoot)
      if (!identity.ok) {
        return errorToolResult(traceId, identity.error)
      }
      await this.ensureStarted(identity.identity)
      const result = await this.call(rpcMethod, params, { traceId })
      return normalizeToolResult(result, traceId)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return errorToolResult(traceId, this.lastError)
    }
  }

  // ---- JSON-RPC 传输 --------------------------------------------------------

  private call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number; traceId?: string } = {},
  ): Promise<T> {
    if (!this.running || !this.child) {
      return Promise.reject(new SidecarBridgeError(`sidecar 未运行，无法调用 ${method}`))
    }
    const id = this.nextId++
    const traceId = options.traceId?.trim() || randomUUID()
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs
    const fullParams = { ...params, trace_id: traceId }
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params: fullParams }) + '\n'

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SidecarTimeoutError(method, timeoutMs, traceId))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      })
      const ok = this.child!.stdin.write(line, 'utf8')
      if (!ok) this.child!.stdin.once('drain', () => undefined)
    })
  }

  private buildEnv(identity: SidecarIdentity): NodeJS.ProcessEnv {
    return buildSidecarEnv(process.env, this.config, null, identity.allowedRoots)
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let idx: number
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1)
      if (line.length > 0) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      console.warn(`[xiaogui] stdout 出现非法 JSON: ${line}`)
      return
    }
    const items = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of items) {
      this.handleResponse(item as {
        id?: number | string | null
        result?: unknown
        error?: { code: number; message: string; data?: unknown }
      })
    }
  }

  private handleResponse(response: {
    id?: number | string | null
    result?: unknown
    error?: { code: number; message: string; data?: unknown }
  }): void {
    if (response.id === undefined || response.id === null) return
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.error) {
      pending.reject(new SidecarRpcError(response.error.code, response.error.message, response.error.data))
      return
    }
    pending.resolve(response.result)
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk
    let idx: number
    while ((idx = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, idx).trimEnd()
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1)
      if (line.length > 0) console.log(`[xiaogui:sidecar] ${line}`)
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private killChild(child: ChildProcessWithoutNullStreams, errorPrefix: string): void {
    if (child.exitCode !== null) return
    try {
      child.kill('SIGKILL')
    } catch (err) {
      this.lastError = `${errorPrefix}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/** 全局单例：被 ipc-handlers / initXiaogui 引用。 */
export const xiaogui = new XiaoguiIntegration()

export function createXiaoguiIntegrationForTest(
  deps: XiaoguiIntegrationDeps,
): XiaoguiIntegrationTestInstance {
  return new XiaoguiIntegration(deps)
}

/** 校验 mode 字符串（供 IPC handler 复用）。 */
export { isXiaoguiMode }
