import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

// 内存版 electron-store 替身：sidecar-bridge → scope-store 在模块加载期构造
// electron-store，测试环境无 Electron app，用空实现替身（同 scope-store.test.ts）。
vi.mock('electron-store', () => {
  class FakeStore<T extends object> {
    private readonly defaults: Partial<T>
    constructor(options?: { name?: string; defaults?: Partial<T>; clearInvalidConfig?: boolean }) {
      this.defaults = options?.defaults ?? {}
    }
    get<K extends string>(key: K): unknown {
      return (this.defaults as Record<string, unknown>)[key]
    }
    set(key: string, value: unknown): void {
      void key
      void value
    }
  }
  return { default: FakeStore }
})

import {
  buildSidecarEnv,
  createXiaoguiIntegrationForTest,
  planSidecarLifecycle,
  resolveAllowedRoots,
  resolveSidecarIdentity,
} from './sidecar-bridge'
import type { XiaoguiBridgeConfig } from './config'

interface JsonRpcRequest {
  id: number | string
  method: string
  params?: Record<string, unknown>
}

class FakeReadable extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): void {
    /* test double */
  }
}

class FakeStdin extends EventEmitter {
  constructor(private readonly child: FakeChildProcess) {
    super()
  }

  write(line: string, _encoding: BufferEncoding): boolean {
    const request = JSON.parse(line) as JsonRpcRequest
    this.child.requests.push(request)
    if (request.method === 'runtime.initialize' && this.child.autoInitialize) {
      queueMicrotask(() => this.child.respond(request.id, {}))
    }
    if (request.method === 'runtime.shutdown' && this.child.autoShutdown) {
      queueMicrotask(() => this.child.respond(request.id, {}))
    }
    return true
  }
}

interface FakeChildProcessOptions {
  autoInitialize?: boolean
  autoShutdown?: boolean
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new FakeStdin(this)
  readonly stdout = new FakeReadable()
  readonly stderr = new FakeReadable()
  readonly requests: JsonRpcRequest[] = []
  readonly autoInitialize: boolean
  readonly autoShutdown: boolean
  exitCode: number | null = null
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true)

  constructor(options: FakeChildProcessOptions = {}) {
    super()
    this.autoInitialize = options.autoInitialize ?? true
    this.autoShutdown = options.autoShutdown ?? true
  }

  emitSpawn(): void {
    this.emit('spawn')
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.emit('exit', code, signal)
  }

  respond(id: number | string, result: unknown): void {
    this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  latestRequest(method: string): JsonRpcRequest | undefined {
    return [...this.requests].reverse().find((request) => request.method === method)
  }

  requestsFor(method: string): JsonRpcRequest[] {
    return this.requests.filter((request) => request.method === method)
  }
}

const baseConfig: XiaoguiBridgeConfig = {
  repoRoot: '',
  pythonCommand: 'python',
  pythonCwd: 'D:/runtime',
  runtimeSource: 'env-runtime-dir',
  runtimeError: null,
  allowedRoots: [],
  requestTimeoutMs: 30_000,
  shutdownTimeoutMs: 1,
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition was not met before timeout')
}

describe('resolveAllowedRoots（白名单默认收敛）', () => {
  it('未显式配置时收敛为 [当前项目根]', () => {
    expect(resolveAllowedRoots([], 'D:/proj/demo')).toEqual(['D:/proj/demo'])
  })

  it('显式配置存在时用配置 ∪ 当前项目根（向后兼容）', () => {
    expect(resolveAllowedRoots(['D:/x', 'D:/y'], 'D:/proj/demo')).toEqual([
      'D:/x',
      'D:/y',
      'D:/proj/demo',
    ])
  })

  it('去重与去空：项目根与配置重复或为空时不重复/不注入', () => {
    expect(resolveAllowedRoots(['D:/proj/demo'], 'D:/proj/demo')).toEqual(['D:/proj/demo'])
    expect(resolveAllowedRoots([''], '  ')).toEqual([])
    expect(resolveAllowedRoots([], null)).toEqual([])
  })
})

describe('buildSidecarEnv（sidecar 子进程 env 构造）', () => {
  it('未配置 allowedRoots 时 env 注入当前项目根（安全默认）', () => {
    const env = buildSidecarEnv({}, { allowedRoots: [], requestTimeoutMs: 30_000 }, 'D:/proj/demo')
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBe('D:/proj/demo')
  })

  it('显式配置时 env 为配置 ∪ 当前项目根', () => {
    const env = buildSidecarEnv(
      {},
      { allowedRoots: ['D:/x'], requestTimeoutMs: 30_000 },
      'D:/proj/demo',
    )
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBe(['D:/x', 'D:/proj/demo'].join(path.delimiter))
  })

  it('两者皆空时显式传空白名单，调用层必须先 fail-closed', () => {
    const env = buildSidecarEnv({}, { allowedRoots: [], requestTimeoutMs: 30_000 }, null)
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBe('')
  })

  it('透传 base env 并注入 XIAOGUI_REQUEST_TIMEOUT（秒）', () => {
    const env = buildSidecarEnv({ FOO: 'bar' }, { allowedRoots: [], requestTimeoutMs: 30_000 })
    expect(env['FOO']).toBe('bar')
    expect(env['XIAOGUI_REQUEST_TIMEOUT']).toBe('30')
  })

  it('传入 effectiveAllowedRoots 时直接采用，不再解析 projectRoot/configRoots', () => {
    const env = buildSidecarEnv(
      {},
      { allowedRoots: ['D:/ignored'], requestTimeoutMs: 30_000 },
      'D:/ignored-project',
      ['D:/effective'],
    )
    expect(env['XIAOGUI_ALLOWED_ROOTS']).toBe('D:/effective')
  })
})

describe('resolveSidecarIdentity（启动身份与 fail-closed）', () => {
  it('没有 runtime 时返回结构化错误，不启动 sidecar', () => {
    const result = resolveSidecarIdentity(
      {
        pythonCwd: null,
        runtimeError: 'runtime missing',
        allowedRoots: [],
      },
      'D:/proj/demo',
    )
    expect(result).toEqual({ ok: false, error: 'runtime missing' })
  })

  it('没有项目根且没有显式白名单时拒绝项目工具', () => {
    const result = resolveSidecarIdentity(
      {
        pythonCwd: 'D:/runtime',
        runtimeError: null,
        allowedRoots: [],
      },
      null,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('空白名单')
  })

  it('没有项目根但有显式白名单时允许项目工具', () => {
    const result = resolveSidecarIdentity(
      {
        pythonCwd: 'D:/runtime',
        runtimeError: null,
        allowedRoots: ['D:/allowed'],
      },
      null,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.identity.allowedRoots).toEqual(['D:/allowed'])
      expect(result.identity.runtimeDir).toBe('D:/runtime')
    }
  })

  it('启动身份包含 runtimeDir 与白名单；项目 A/B key 不同', () => {
    const base = {
      pythonCwd: 'D:/runtime',
      runtimeError: null,
      allowedRoots: [],
    }
    const a = resolveSidecarIdentity(base, 'D:/proj/a')
    const b = resolveSidecarIdentity(base, 'D:/proj/b')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.identity.allowedRoots).toEqual(['D:/proj/a'])
      expect(b.identity.allowedRoots).toEqual(['D:/proj/b'])
      expect(a.identity.key).not.toBe(b.identity.key)
    }
  })
})

describe('planSidecarLifecycle（项目切换生命周期策略）', () => {
  it('未运行时启动；身份相同时复用', () => {
    expect(
      planSidecarLifecycle({
        running: false,
        activeIdentityKey: null,
        nextIdentityKey: 'a',
        pendingRequests: 0,
      }),
    ).toBe('start')
    expect(
      planSidecarLifecycle({
        running: true,
        activeIdentityKey: 'a',
        nextIdentityKey: 'a',
        pendingRequests: 0,
      }),
    ).toBe('reuse')
  })

  it('项目 A 切到 B：无挂起请求时重启，有挂起请求时确定性拒绝', () => {
    expect(
      planSidecarLifecycle({
        running: true,
        activeIdentityKey: 'project-a',
        nextIdentityKey: 'project-b',
        pendingRequests: 0,
      }),
    ).toBe('restart')
    expect(
      planSidecarLifecycle({
        running: true,
        activeIdentityKey: 'project-a',
        nextIdentityKey: 'project-b',
        pendingRequests: 1,
      }),
    ).toBe('reject')
  })

  it('启动中：相同身份等待同一个启动 Promise，不同身份确定性拒绝', () => {
    expect(
      planSidecarLifecycle({
        running: false,
        activeIdentityKey: null,
        nextIdentityKey: 'project-a',
        pendingRequests: 0,
        startingIdentityKey: 'project-a',
      }),
    ).toBe('await-starting')
    expect(
      planSidecarLifecycle({
        running: false,
        activeIdentityKey: null,
        nextIdentityKey: 'project-b',
        pendingRequests: 0,
        startingIdentityKey: 'project-a',
      }),
    ).toBe('reject')
  })

  it('关闭中：即使身份相同也先拒绝，不复用旧进程', () => {
    expect(
      planSidecarLifecycle({
        running: true,
        activeIdentityKey: 'project-a',
        nextIdentityKey: 'project-a',
        pendingRequests: 0,
        shuttingDown: true,
      }),
    ).toBe('reject')
  })
})

describe('XiaoguiIntegration sidecar lifecycle regressions', () => {
  it('新会话默认允许受控执行，不强制先进入 ASK', () => {
    const integration = createXiaoguiIntegrationForTest({
      config: baseConfig,
      mode: 'CODING',
      spawnSidecar: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
    })

    expect(integration.getExecutionPhase()).toBe('EXECUTE')
  })

  it('spawn 未完成时 shutdown 会快速取消启动、kill child，迟到 spawn 不会发 RPC', async () => {
    const children: FakeChildProcess[] = []
    const integration = createXiaoguiIntegrationForTest({
      config: { ...baseConfig, shutdownTimeoutMs: 30_000 },
      mode: 'WORK',
      spawnSidecar: () => {
        const child = new FakeChildProcess()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    const invoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-cancel' },
      { projectRoot: 'D:/project-a' },
    )
    await waitFor(() => children[0])

    const shutdownResult = await Promise.race([
      integration.shutdown().then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ])

    expect(shutdownResult).toBe('done')
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')

    const result = await invoke
    expect(result).toMatchObject({
      status: 'error',
      trace_id: 'trace-cancel',
    })
    expect(result.warnings[0]).toContain('启动已被 shutdown 取消')
    expect(children[0].requests).toEqual([])
    expect(integration.status()).toMatchObject({
      running: false,
      activeAllowedRoots: [],
      pendingRequests: 0,
    })

    children[0].emitSpawn()
    await Promise.resolve()
    expect(children[0].kill.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(children[0].requests).toEqual([])
    expect(integration.status()).toMatchObject({
      running: false,
      activeAllowedRoots: [],
      pendingRequests: 0,
    })
  })

  it('spawn resolve 后 continuation 未执行时 shutdown 仍会取消启动，不会 initialize/inspect', async () => {
    const children: FakeChildProcess[] = []
    const integration = createXiaoguiIntegrationForTest({
      config: { ...baseConfig, shutdownTimeoutMs: 30_000 },
      mode: 'WORK',
      spawnSidecar: () => {
        const child = new FakeChildProcess()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    const invoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-spawn-race' },
      { projectRoot: 'D:/project-a' },
    )
    await waitFor(() => children[0])
    children[0].emitSpawn()

    const shutdownResult = await Promise.race([
      integration.shutdown().then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ])

    expect(shutdownResult).toBe('done')
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')

    const result = await invoke
    expect(result).toMatchObject({
      status: 'error',
      trace_id: 'trace-spawn-race',
    })
    expect(result.warnings[0]).toContain('启动已被 shutdown 取消')
    expect(children[0].requests).toEqual([])
    await Promise.resolve()
    expect(children[0].requests).toEqual([])
    expect(integration.status()).toMatchObject({
      running: false,
      activeAllowedRoots: [],
      pendingRequests: 0,
    })
  })

  it('同身份启动并发共享同一个 child，并在启动完成后分别执行请求', async () => {
    const children: FakeChildProcess[] = []
    const integration = createXiaoguiIntegrationForTest({
      config: baseConfig,
      mode: 'WORK',
      spawnSidecar: () => {
        const child = new FakeChildProcess()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    const firstInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-a' },
      { projectRoot: 'D:/project-a' },
    )
    const secondInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-b' },
      { projectRoot: 'D:/project-a' },
    )

    expect(children).toHaveLength(1)
    children[0].emitSpawn()
    await waitFor(() =>
      children[0].requestsFor('design.project.inspect').length === 2
        ? children[0].requestsFor('design.project.inspect')
        : undefined,
    )

    const inspectRequests = children[0].requestsFor('design.project.inspect')
    children[0].respond(inspectRequests[0].id, { first: true })
    children[0].respond(inspectRequests[1].id, { second: true })

    await expect(firstInvoke).resolves.toMatchObject({
      status: 'ok',
      data: { result: { first: true } },
      trace_id: 'trace-a',
    })
    await expect(secondInvoke).resolves.toMatchObject({
      status: 'ok',
      data: { result: { second: true } },
      trace_id: 'trace-b',
    })
    expect(children).toHaveLength(1)
  })

  it('异身份启动中通过 ensureStarted 真实路径确定性拒绝，不等待旧启动完成', async () => {
    const children: FakeChildProcess[] = []
    const integration = createXiaoguiIntegrationForTest({
      config: baseConfig,
      mode: 'WORK',
      spawnSidecar: () => {
        const child = new FakeChildProcess()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    const firstInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-a' },
      { projectRoot: 'D:/project-a' },
    )
    const rejectedInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-b' },
      { projectRoot: 'D:/project-b' },
    )

    await expect(rejectedInvoke).resolves.toMatchObject({
      status: 'error',
      trace_id: 'trace-b',
    })
    expect((await rejectedInvoke).warnings[0]).toContain('正在切换')
    expect(children).toHaveLength(1)

    children[0].emitSpawn()
    const inspect = await waitFor(() => children[0].latestRequest('design.project.inspect'))
    children[0].respond(inspect.id, { first: true })
    await expect(firstInvoke).resolves.toMatchObject({
      status: 'ok',
      trace_id: 'trace-a',
    })
  })

  it('关闭中同身份调用通过 ensureStarted 真实路径拒绝，且不向旧 child 复用发请求', async () => {
    const children: FakeChildProcess[] = []
    const integration = createXiaoguiIntegrationForTest({
      config: { ...baseConfig, shutdownTimeoutMs: 30_000 },
      mode: 'WORK',
      spawnSidecar: () => {
        const child = new FakeChildProcess({ autoShutdown: false })
        children.push(child)
        queueMicrotask(() => child.emitSpawn())
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    const firstInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-a' },
      { projectRoot: 'D:/project-a' },
    )
    const firstInspect = await waitFor(() => children[0]?.latestRequest('design.project.inspect'))
    children[0].respond(firstInspect.id, { first: true })
    await expect(firstInvoke).resolves.toMatchObject({ status: 'ok' })

    const shutdown = integration.shutdown()
    const shutdownRequest = await waitFor(() => children[0].latestRequest('runtime.shutdown'))
    const inspectCountBefore = children[0].requestsFor('design.project.inspect').length

    const rejectedInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-b' },
      { projectRoot: 'D:/project-a' },
    )

    await expect(rejectedInvoke).resolves.toMatchObject({
      status: 'error',
      trace_id: 'trace-b',
    })
    expect((await rejectedInvoke).warnings[0]).toContain('正在切换')
    expect(children).toHaveLength(1)
    expect(children[0].requestsFor('design.project.inspect')).toHaveLength(inspectCountBefore)

    children[0].respond(shutdownRequest.id, {})
    await Promise.resolve()
    children[0].emitExit(0, null)
    await shutdown
  })

  it('initialize pending 时普通 shutdown 主动清 pending 并等待 starting 收敛，随后可重新启动', async () => {
    const children: FakeChildProcess[] = []
    const integration = createXiaoguiIntegrationForTest({
      config: { ...baseConfig, shutdownTimeoutMs: 1 },
      mode: 'WORK',
      spawnSidecar: () => {
        const child =
          children.length === 0
            ? new FakeChildProcess({ autoInitialize: false, autoShutdown: false })
            : new FakeChildProcess()
        children.push(child)
        queueMicrotask(() => child.emitSpawn())
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    const firstInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-init-pending' },
      { projectRoot: 'D:/project-a' },
    )
    await waitFor(() => children[0]?.latestRequest('runtime.initialize'))

    const shutdownResult = await Promise.race([
      integration.shutdown().then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    expect(shutdownResult).toBe('done')

    const firstResult = await Promise.race([
      firstInvoke,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    expect(firstResult).not.toBe('timeout')
    expect(firstResult).toMatchObject({
      status: 'error',
      trace_id: 'trace-init-pending',
    })
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(children[0].requestsFor('design.project.inspect')).toEqual([])
    expect(integration.status()).toMatchObject({
      running: false,
      activeAllowedRoots: [],
      pendingRequests: 0,
    })

    const secondInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-restart' },
      { projectRoot: 'D:/project-a' },
    )
    const secondInspect = await waitFor(() => children[1]?.latestRequest('design.project.inspect'))
    children[1].respond(secondInspect.id, { restarted: true })
    await expect(secondInvoke).resolves.toMatchObject({
      status: 'ok',
      data: { result: { restarted: true } },
      trace_id: 'trace-restart',
    })
    expect(integration.status()).toMatchObject({
      running: true,
      activeAllowedRoots: ['D:/project-a'],
      pendingRequests: 0,
    })
  })

  it('spawn 后 child.exitCode 已非 null 时启动失败，不继续假装 running', async () => {
    const children: FakeChildProcess[] = []
    const integration = createXiaoguiIntegrationForTest({
      config: baseConfig,
      mode: 'WORK',
      spawnSidecar: () => {
        const child = new FakeChildProcess()
        children.push(child)
        queueMicrotask(() => {
          child.exitCode = 1
          child.emitSpawn()
        })
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    const result = await integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-a' },
      { projectRoot: 'D:/project-a' },
    )

    expect(result).toMatchObject({
      status: 'error',
      trace_id: 'trace-a',
    })
    expect(result.warnings[0]).toContain('sidecar 启动后立刻退出')
    expect(children[0].requests).toEqual([])
    expect(integration.status()).toMatchObject({
      running: false,
      activeAllowedRoots: [],
      pendingRequests: 0,
    })
  })

  it('旧 child 的迟到 exit 不会清空新 child 状态或失败新 child 的挂起请求', async () => {
    const children: FakeChildProcess[] = []
    const integration = createXiaoguiIntegrationForTest({
      config: baseConfig,
      mode: 'WORK',
      spawnSidecar: () => {
        const child = new FakeChildProcess()
        children.push(child)
        queueMicrotask(() => child.emitSpawn())
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })

    const firstInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-a' },
      { projectRoot: 'D:/project-a' },
    )
    const firstInspect = await waitFor(() => children[0]?.latestRequest('design.project.inspect'))
    children[0].respond(firstInspect.id, { first: true })
    await expect(firstInvoke).resolves.toMatchObject({ status: 'ok' })

    const secondInvoke = integration.invokeTool(
      { tool: 'design.project', action: 'inspect', trace_id: 'trace-b' },
      { projectRoot: 'D:/project-b' },
    )
    const secondInspect = await waitFor(() => children[1]?.latestRequest('design.project.inspect'))

    // 旧进程的迟到半截 JSON 不能污染新进程共享的 stdoutBuffer。
    children[0].stdout.emit('data', '{"jsonrpc":"2.0","id":999')
    children[0].emitExit(0, null)
    expect(integration.status()).toMatchObject({
      running: true,
      activeAllowedRoots: ['D:/project-b'],
      pendingRequests: 1,
    })

    children[1].respond(secondInspect.id, { second: true })
    await expect(secondInvoke).resolves.toMatchObject({
      status: 'ok',
      data: { result: { second: true } },
      trace_id: 'trace-b',
    })
    expect(integration.status()).toMatchObject({
      running: true,
      activeAllowedRoots: ['D:/project-b'],
      pendingRequests: 0,
    })
  })
})
