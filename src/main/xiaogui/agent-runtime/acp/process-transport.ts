import { spawn, type ChildProcess } from 'node:child_process'

import type {
  AcpClientRequestHandlerV1,
  AcpInitializeResultV1,
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
  AcpSessionUpdateParamsV1,
  AcpTransportFactoryV1,
  AcpTransportStartOptionsV1,
  AcpTransportV1,
} from './types'

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout }

export class NdjsonAcpProcessTransportV1 implements AcpTransportV1 {
  private child: ChildProcess | null = null
  private inputBuffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private requestHandlers: ReadonlyMap<string, AcpClientRequestHandlerV1> = new Map()
  private onSessionUpdate: (params: AcpSessionUpdateParamsV1) => void = () => {}
  private onPermissionRequest: (params: AcpRequestPermissionParamsV1) => Promise<AcpRequestPermissionResultV1> = async () => ({ outcome: { outcome: 'cancelled' } })
  private onDisconnect: (reasonCode: string) => void = () => {}

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly cwd: string,
  ) {}

  async start(options: AcpTransportStartOptionsV1): Promise<AcpInitializeResultV1> {
    this.requestHandlers = options.requestHandlers
    this.onSessionUpdate = options.onSessionUpdate
    this.onPermissionRequest = options.onPermissionRequest
    this.onDisconnect = options.onDisconnect
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.command)
    const command = useShell ? `"${this.command}" ${this.args.join(' ')}` : this.command
    this.child = spawn(command, useShell ? [] : [...this.args], {
      cwd: this.cwd,
      shell: useShell,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout?.on('data', (chunk: Buffer | string) => this.readStdout(chunk))
    this.child.on('error', () => this.close('PROCESS_ERROR'))
    this.child.on('close', () => this.close('PROCESS_DISCONNECTED'))
    return this.call<AcpInitializeResultV1>('initialize', options.initialize, 30000)
  }

  newSession(cwd: string): Promise<{ sessionId: string }> {
    return this.call('session/new', { cwd, mcpServers: [] }, 30000)
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.call('session/load', { sessionId, cwd, mcpServers: [] }, 30000)
  }

  prompt(sessionId: string, prompt: Array<{ type: string; text?: string }>): Promise<{ stopReason?: string }> {
    return this.call('session/prompt', { sessionId, prompt }, 600000)
  }

  async cancel(sessionId: string): Promise<void> {
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  }

  async dispose(): Promise<void> {
    const child = this.child
    if (child && child.exitCode === null && !child.killed) {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref()
      } else {
        child.kill('SIGTERM')
      }
    }
    this.close('DISPOSED')
  }

  private call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.close('ACP_REQUEST_TIMEOUT')
        reject(new Error('ACP_TIMEOUT'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private write(message: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  private readStdout(chunk: Buffer | string): void {
    this.inputBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = this.inputBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.inputBuffer.slice(0, index).trim()
      this.inputBuffer = this.inputBuffer.slice(index + 1)
      this.handleLine(line)
      index = this.inputBuffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    if (!line) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.close('ACP_MALFORMED_MESSAGE')
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.close('ACP_MALFORMED_MESSAGE')
      return
    }
    const message = parsed as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
    if (typeof message.method === 'string' && message.method === 'session/update') {
      this.onSessionUpdate(message.params as AcpSessionUpdateParamsV1)
      return
    }
    if (typeof message.method === 'string' && message.id !== undefined) {
      void this.handleReverseRequest(message.id, message.method, message.params)
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error('ACP_REMOTE_ERROR'))
      else pending.resolve(message.result)
    }
  }

  private async handleReverseRequest(id: number, method: string, params: unknown): Promise<void> {
    if (method === 'session/request_permission') {
      try {
        this.write({ jsonrpc: '2.0', id, result: await this.onPermissionRequest(params as AcpRequestPermissionParamsV1) })
      } catch {
        this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
      }
      return
    }
    const handler = this.requestHandlers.get(method)
    if (!handler) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
      return
    }
    try {
      this.write({ jsonrpc: '2.0', id, result: await handler(params) })
    } catch {
      this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'denied' } })
    }
  }

  private close(reasonCode: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reasonCode))
    }
    this.pending.clear()
    this.onDisconnect(reasonCode)
  }
}

export class KimiAcpProcessTransportFactoryV1 implements AcpTransportFactoryV1 {
  create(command: string, args: readonly string[], cwd: string): AcpTransportV1 {
    return new NdjsonAcpProcessTransportV1(command, args, cwd)
  }
}
