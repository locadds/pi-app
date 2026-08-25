import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type {
  CodexHeadlessDriverEventV1,
  CodexHeadlessDriverSessionV1,
  CodexHeadlessDriverV1,
  CodexHeadlessProbeV1,
} from './codex-headless-adapter'

export interface CodexHeadlessProcessOptionsV1 {
  command?: string
  startTimeoutMs?: number
}

export class CodexCliProbeV1 implements CodexHeadlessProbeV1 {
  constructor(private readonly options: CodexHeadlessProcessOptionsV1 = {}) {}

  async findExecutable() {
    const command = safeCommand(this.options.command)
    try {
      const result = await runVersion(command, this.options.startTimeoutMs ?? 5_000)
      return result.ok
        ? { available: true as const, version: result.version }
        : { available: false as const, reasonCode: result.reasonCode }
    } catch {
      return { available: false as const, reasonCode: 'CODEX_CLI_NOT_FOUND' }
    }
  }
}

/**
 * Thin process Implementation for the official `codex exec --json` protocol.
 * All raw output and filesystem paths stay inside the main process.
 */
export class CodexCliProcessDriverV1 implements CodexHeadlessDriverV1 {
  readonly supportsCrossProcessResultReconcile = false

  constructor(private readonly options: CodexHeadlessProcessOptionsV1 = {}) {}

  async start(input: { rootPath: string; prompt: string; resumeSessionId?: string }): Promise<CodexHeadlessDriverSessionV1> {
    const command = safeCommand(this.options.command)
    const args = ['exec', '--json', '--sandbox', 'workspace-write', '-C', input.rootPath]
    if (input.resumeSessionId) args.push('resume', input.resumeSessionId)
    args.push('-')
    const child = spawn(command, args, {
      cwd: input.rootPath,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const session = new CodexCliProcessSessionV1(child, input.rootPath, input.resumeSessionId)
    child.stdin.end(input.prompt, 'utf8')
    try {
      await session.waitUntilIdentified(this.options.startTimeoutMs ?? 10_000)
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }

  async restore(input: { rootPath: string; vendorSessionId: string }): Promise<CodexHeadlessDriverSessionV1> {
    // `codex exec resume` requires the next prompt. Recovery therefore keeps
    // only the official thread id and obtains the approved worktree on demand;
    // it does not replay or persist a previous prompt.
    await realpath(input.rootPath)
    return new RestoredCodexCliSessionV1(input.rootPath, input.vendorSessionId)
  }
}

class RestoredCodexCliSessionV1 implements CodexHeadlessDriverSessionV1 {
  constructor(
    private readonly rootPath: string,
    readonly vendorSessionId: string,
  ) {}

  events(): readonly CodexHeadlessDriverEventV1[] { return [] }
  async outcome() { return 'UNKNOWN' as const }
  async candidateDigest(): Promise<string | null> { return gitWorktreeDigest(this.rootPath) }
  async interrupt(): Promise<boolean> { return false }
  async close(): Promise<void> { return undefined }
}

class CodexCliProcessSessionV1 implements CodexHeadlessDriverSessionV1 {
  vendorSessionId = ''
  private readonly capturedEvents: CodexHeadlessDriverEventV1[] = []
  private currentOutcome: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' = 'RUNNING'
  private stdoutBuffer = ''
  private settled = false
  private identifyResolve?: () => void
  private identifyReject?: (error: Error) => void

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly rootPath: string,
    resumeSessionId?: string,
  ) {
    this.vendorSessionId = resumeSessionId ?? ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.resume()
    child.on('error', () => this.finish('FAILED'))
    child.on('exit', (code, signal) => {
      if (this.currentOutcome === 'RUNNING') this.finish(signal ? 'INTERRUPTED' : code === 0 ? 'SUCCEEDED' : 'FAILED')
    })
  }

  events(): readonly CodexHeadlessDriverEventV1[] { return [...this.capturedEvents] }
  async outcome() { return this.currentOutcome }
  async candidateDigest(): Promise<string | null> {
    return this.currentOutcome === 'SUCCEEDED' ? gitWorktreeDigest(this.rootPath) : null
  }

  async interrupt(): Promise<boolean> {
    if (this.currentOutcome !== 'RUNNING') return false
    const requested = this.child.kill()
    if (requested) this.finish('INTERRUPTED')
    return requested
  }

  async close(): Promise<void> {
    if (this.currentOutcome === 'RUNNING') this.child.kill()
  }

  waitUntilIdentified(timeoutMs: number): Promise<void> {
    if (this.vendorSessionId) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CODEX_THREAD_ID_TIMEOUT')), timeoutMs)
      this.identifyResolve = () => { clearTimeout(timer); resolve() }
      this.identifyReject = (error) => { clearTimeout(timer); reject(error) }
      if (this.vendorSessionId) this.identifyResolve()
      else if (this.settled) this.identifyReject(new Error('CODEX_THREAD_ID_MISSING'))
    })
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) this.consumeLine(line)
  }

  private consumeLine(line: string): void {
    let event: Record<string, unknown>
    try { event = JSON.parse(line) as Record<string, unknown> } catch { return }
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'thread.started' && typeof event.thread_id === 'string') {
      this.vendorSessionId = event.thread_id
      this.identifyResolve?.()
      return
    }
    if (type === 'item.completed' && isRecord(event.item)) {
      const itemType = typeof event.item.type === 'string' ? event.item.type : ''
      if (itemType === 'agent_message') {
        this.capturedEvents.push({ type: 'TEXT', text: typeof event.item.text === 'string' ? event.item.text : '' })
      } else if (itemType) {
        this.capturedEvents.push({ type: 'TOOL', toolName: itemType })
      }
      return
    }
    if (type === 'turn.completed') this.finish('SUCCEEDED')
    else if (type === 'turn.failed' || type === 'error') this.finish('FAILED')
  }

  private finish(outcome: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'): void {
    if (this.settled) return
    this.settled = true
    this.currentOutcome = outcome
    this.capturedEvents.push({ type: 'SETTLED', outcome })
    if (!this.vendorSessionId) this.identifyReject?.(new Error('CODEX_THREAD_ID_MISSING'))
  }
}

async function runVersion(command: string, timeoutMs: number): Promise<
  | { ok: true; version: string }
  | { ok: false; reasonCode: string }
> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, reasonCode: 'CODEX_CLI_PROBE_TIMEOUT' }) }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (output.length < 256) output += chunk })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, reasonCode: 'CODEX_CLI_NOT_FOUND' }) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve({ ok: false, reasonCode: 'CODEX_CLI_PROBE_FAILED' })
      const version = output.trim().split(/\s+/).at(-1)
      resolve(version ? { ok: true, version } : { ok: false, reasonCode: 'CODEX_CLI_VERSION_UNKNOWN' })
    })
  })
}

function safeCommand(value?: string): string {
  const command = value?.trim() || process.env.XIAOGUI_CODEX_CLI?.trim() || 'codex'
  if (!command || /[\r\n\0]/.test(command)) throw new Error('CODEX_CLI_COMMAND_INVALID')
  return command
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function gitWorktreeDigest(rootPath: string): Promise<string | null> {
  try {
    const root = await realpath(rootPath)
    const [diff, untrackedRaw] = await Promise.all([
      capture('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], root, 64 * 1024 * 1024),
      capture('git', ['ls-files', '--others', '--exclude-standard', '-z'], root, 4 * 1024 * 1024),
    ])
    const hash = createHash('sha256').update('xiaogui-codex-candidate-v1\0').update(diff)
    const untracked = untrackedRaw.toString('utf8').split('\0').filter(Boolean).sort()
    for (const relativePath of untracked) {
      const absolutePath = resolve(root, relativePath)
      const back = relative(root, absolutePath)
      if (!back || back.startsWith('..') || isAbsolute(back)) return null
      const stat = await lstat(absolutePath)
      hash.update('\0untracked\0').update(relativePath).update('\0')
      if (stat.isSymbolicLink()) hash.update(await readlink(absolutePath))
      else if (stat.isFile()) hash.update(await readFile(absolutePath))
      else return null
    }
    return `sha256:${hash.digest('hex')}`
  } catch {
    return null
  }
}

function capture(command: string, args: readonly string[], cwd: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        child.kill()
        reject(new Error('CODEX_CANDIDATE_TOO_LARGE'))
      } else chunks.push(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolvePromise(Buffer.concat(chunks)) : reject(new Error('CODEX_GIT_INSPECT_FAILED')))
  })
}
