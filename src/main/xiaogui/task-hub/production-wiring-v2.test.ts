import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createWriteToolDefinition } from '@earendil-works/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement, type ComponentType } from 'react'
import '@testing-library/jest-dom/vitest'

vi.mock('electron-store', () => ({ default: class {
  private values: Record<string, unknown> = {}
  get(key: string) { return this.values[key] }
  set(key: string, value: unknown) { this.values[key] = value }
  delete(key: string) { delete this.values[key] }
} }))
const ipcHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => Promise<unknown>>())
vi.mock('../../ipc/registry', () => ({ registerHandler: (channel: string, handler: (payload: unknown) => Promise<unknown>) => ipcHandlers.set(channel, handler) }))
vi.mock('@renderer/lib/ipc-client', () => ({ ipcClient: { invoke: (method: string, payload?: unknown) => {
  const handler = ipcHandlers.get(`ipc:${method}`)
  return handler ? handler(payload) : Promise.resolve({ ok: false, code: 'IPC_HANDLER_MISSING' })
} } }))

import type { AppEvent } from '@shared/app-events'
import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { PiRuntimeOptionsV1 } from '../agent-runtime/pi-adapter'
import type { PiAttemptWorkerPortV1 } from '../agent-runtime/pi-worker-port'
import { createInMemoryHubTaskWorkerStateStoreV1 } from '../hub-task/worker-state'
import { createInMemoryHubTaskWorkerCredentialsV1 } from '../hub-task/worker-service'
import { createHubTaskWorkerCompositionV1 } from '../hub-task/worker-composition'
import { registerHubTaskWorkerHandlers } from '../hub-task/worker-ipc'
import { createPiAttemptDeleteToolDefinitionV1, createPiAttemptRenameToolDefinitionV1, createPiAttemptToolLifecycleV1 } from '../../../worker/xiaogui-coding-extensions/attempt-tool-extension'
import { createXiaoguiRuntimeCompositionV1, type XiaoguiRuntimeCompositionV1 } from './runtime-composition'
import { createHubTaskExecutionLifecycleCoordinatorV1 } from './hub-execution-lifecycle'

const roots: string[] = []
const compositions: XiaoguiRuntimeCompositionV1[] = []
const ADDRESS = { projectId: `xgp1_${'d'.repeat(64)}`, sessionKey: `xgs1_${'e'.repeat(64)}` } as HubAddressV1
const PACKAGE = `sha256:${'f'.repeat(64)}`
const NOW = '2026-09-15T12:00:00.000Z'

afterEach(async () => {
  cleanup()
  for (const composition of compositions.splice(0).reverse()) await composition.close().catch(() => undefined)
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  ipcHandlers.clear()
})

it('runs the registered accept handler through default Main Pi verification, automatic Delivery, and V2 review diff', async () => {
  const projectRoot = fixtureProject()
  const userDataDir = temp('xiaogui-production-wiring-user-')
  let promptCount = 0
  let closeCount = 0
  const workerFactory: NonNullable<PiRuntimeOptionsV1['workerFactory']> = input => {
    let sessionId = ''
    let sessionFile = ''
    let requestOrdinal = 0
    const request = async (tool: Omit<WorkerHostToolRequestV1, 'type' | 'requestId'>) => input.onTool({
      request: { type: 'host-tool-request', requestId: `host-${++requestOrdinal}`, ...tool } as WorkerHostToolRequestV1,
      fromCwd: input.rootPath, fromPoolKey: input.rootPath, fromSessionId: sessionId, sessionFile,
    })
    const worker: PiAttemptWorkerPortV1 = {
      async start() {
        expect(input.worktreeAuthorized).toBe(true)
        sessionId = 'production-wiring-pi-session'
        sessionFile = join(input.rootPath, '.pi', 'session.jsonl')
        mkdirSync(join(input.rootPath, '.pi'), { recursive: true })
        return { sessionId, sessionFile, model: 'fixture/model' }
      },
      async setModel() { return 'fixture/model' },
      async prompt() {
        promptCount += 1
        const lifecycle = createPiAttemptToolLifecycleV1({ attemptId: input.scope.attemptId,
          sourceSessionId: () => sessionId, request: request as never })
        const write = lifecycle.wrapDefinition(createWriteToolDefinition(input.rootPath))
        const remove = lifecycle.wrapDefinition(createPiAttemptDeleteToolDefinitionV1(input.rootPath))
        const rename = lifecycle.wrapDefinition(createPiAttemptRenameToolDefinitionV1(input.rootPath))
        await write.execute('modify', { path: 'src/modify.ts', content: 'export const modified: number = 2\n' }, undefined, undefined, {} as never)
        await write.execute('create', { path: 'src/created.ts', content: 'export const created = true\n' }, undefined, undefined, {} as never)
        await remove.execute('delete', { path: 'src/delete.txt' }, undefined, undefined, {} as never)
        await rename.execute('rename', { sourcePath: 'src/rename.txt', targetPath: 'src/renamed.txt' }, undefined, undefined, {} as never)
        input.onEvent({ type: 'run', phase: 'idle', settled: true, seq: 1, workspaceId: input.scope.projectId,
          sessionId, sessionFile, runId: 'run-1', turnId: 'turn-1', timestamp: Date.now() } satisfies AppEvent)
      },
      async abort() {},
      async close() { closeCount += 1 },
    }
    return worker
  }
  const composition = createXiaoguiRuntimeCompositionV1({ userDataDir, productionEnabled: false,
    lookup: { lookup: async address => ({ kind: 'FOUND', scope: { ...address, sessionMode: 'CODING' } }) },
    projectResolver: { resolveProjectRoot: () => projectRoot }, piWorkerFactory: workerFactory })
  compositions.push(composition)

  const state = createInMemoryHubTaskWorkerStateStoreV1()
  state.upsertAssignment(assignment(), { subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1' })
  state.markOpened('assignment-1', NOW)
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  const privateKeyPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  credentials.write({ endpoint: 'http://offline.invalid', accessToken: 'a'.repeat(20), node: {
    subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1', deviceToken: 'device', privateKeyPem,
  } })
  const service = createHubTaskWorkerCompositionV1({ state, credentials, application: composition.application,
    createPort: () => ({ downloadAssignment: async () => assignment(), submitDecision: async () => assignment('ACCEPTED'),
      submitReceipt: async () => { throw new Error('offline') } }) as never,
    acceptAndExecuteV2: composition.acceptAndExecuteTrustedPortV2,
  })
  const executionLifecycle = createHubTaskExecutionLifecycleCoordinatorV1({ application: composition.application,
    taskExecution: composition.taskExecution, delivery: composition.delivery, evidence: service })
  composition.taskExecution.setExecutionLifecycle(executionLifecycle)
  registerHubTaskWorkerHandlers(service, `sha256:${'1'.repeat(64)}`)
  try {
    const rendererComponentPath = '../../../renderer/src/xiaogui/components/HubTaskInboxSection'
    const { HubTaskInboxSection } = await import(rendererComponentPath) as { HubTaskInboxSection: ComponentType<{
      address: HubAddressV1; targetProjectLabel: string; targetProjectPath: string
    }> }
    render(createElement(HubTaskInboxSection, { address: ADDRESS, targetProjectLabel: '测试项目', targetProjectPath: '受控路径' }))
    const acceptButton = await screen.findByRole('button', { name: '接受并执行' })
    await waitFor(() => expect(acceptButton).toBeEnabled())
    await userEvent.click(acceptButton)
    await screen.findByText(/任务已接受/, {}, { timeout: 30_000 })
    const attemptId = state.requireAssignment('assignment-1').acceptAndExecuteV2?.attemptId
    expect(attemptId).toBeTruthy()
    try {
      await vi.waitFor(async () => {
        const projection = await composition.application.observeM2B(ADDRESS)
        if (!projection.ok) throw new Error(projection.error.code)
        const item = projection.value.attempts.find(candidate => candidate.attemptId === attemptId)
        expect(item, JSON.stringify(item)).toMatchObject({ status: 'SUCCEEDED' })
      }, { timeout: 30_000, interval: 100 })
    } catch (error) {
      const db = new (await import('node:sqlite')).DatabaseSync(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-execution-inputs.sqlite'))
      const rows = db.prepare('select data_json from pi_attempt_runtime_v1').all()
      db.close()
      throw new Error(`${String(error)} PI=${JSON.stringify(rows)}`)
    }
    await vi.waitFor(() => expect(composition.delivery.readLatestDelivery(ADDRESS, state.requireAssignment('assignment-1').acceptAndExecuteV2!.flowId as never))
      .toMatchObject({ state: 'READY_FOR_REVIEW' }), { timeout: 30_000, interval: 100 })
    const binding = state.requireAssignment('assignment-1').acceptAndExecuteV2!
    const review = await composition.codingReview.read({ address: ADDRESS, attemptId: attemptId as never })
    expect(review.unifiedDiff).toContain('src/modify.ts')
    expect(review.unifiedDiff).toContain('src/created.ts')
    expect(review.unifiedDiff).toContain('src/delete.txt')
    expect(review.unifiedDiff).toContain('src/rename.txt')
    expect(review.unifiedDiff).toContain('src/renamed.txt')
    expect(review.bundle.unresolvedIssues).toEqual([])
    expect(composition.delivery.readLatestDelivery(ADDRESS, binding.flowId as never)).toMatchObject({ state: 'READY_FOR_REVIEW' })
    await vi.waitFor(() => expect(state.pendingEvidence().filter(item => item.kind === 'RESULT')).toHaveLength(1))
    await executionLifecycle.reconcile({ address: ADDRESS, flowId: binding.flowId!, attemptId: binding.attemptId })
    expect(state.pendingEvidence().filter(item => item.kind === 'RESULT')).toHaveLength(1)
    expect(promptCount).toBe(1)
    expect(closeCount).toBe(1)
  } finally {
    service.close()
  }
}, 60_000)

function assignment(decisionState: 'PENDING' | 'ACCEPTED' = 'PENDING') {
  return { assignment: { assignmentId: 'assignment-1', taskId: 'task-1', decisionState, deliveryState: 'OPENED' as const,
    executionState: 'NOT_STARTED' as const, createdAt: NOW, updatedAt: NOW }, offer: { taskId: 'task-1', mode: 'DIRECT' as const,
    title: '完成四种文件变更', taskContent: '修改、创建、删除并重命名工作树文件。', constraints: [],
    acceptanceRequirements: ['TypeScript检查通过'], attachmentRefs: [], packageSha256: PACKAGE } }
}

function fixtureProject(): string {
  const root = temp('xiaogui-production-wiring-project-')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'modify.ts'), 'export const modified: number = 1\n')
  writeFileSync(join(root, 'src', 'delete.txt'), 'delete me\n')
  writeFileSync(join(root, 'src', 'rename.txt'), 'rename me\n')
  for (const name of ['tsconfig.web.json', 'tsconfig.node.json']) writeFileSync(join(root, name), JSON.stringify({
    compilerOptions: { target: 'ES2020', module: name.includes('node') ? 'NodeNext' : 'ESNext',
      moduleResolution: name.includes('node') ? 'NodeNext' : 'Bundler', strict: true, noEmit: true }, include: ['src/**/*.ts'],
  }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'production-wiring', private: true, type: 'module' }))
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  git(root, ['init']); git(root, ['config', 'core.autocrlf', 'false']); git(root, ['config', 'user.email', 'test@example.test'])
  git(root, ['config', 'user.name', 'test']); git(root, ['add', '.']); git(root, ['commit', '-m', 'baseline'])
  const source = process.cwd()
  if (!existsSync(join(source, 'node_modules', 'typescript'))) throw new Error('TYPESCRIPT_MISSING')
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  cpSync(join(source, 'node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), { recursive: true })
  for (const file of ['tsc', 'tsc.cmd', 'tsc.ps1']) copyFileSync(join(source, 'node_modules', '.bin', file), join(root, 'node_modules', '.bin', file))
  return root
}

function temp(prefix: string): string { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root }
function git(cwd: string, args: readonly string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim() }
