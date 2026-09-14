import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { createReadToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This composition unit reaches Worker configuration, which imports the
// desktop config store. Keep that host-only persistence boundary out of the
// production-runtime journey; the composition itself remains unmocked.
vi.mock('electron-store', () => {
  class ElectronStore {
    private readonly values: Record<string, unknown>

    constructor(options: { defaults?: Record<string, unknown> } = {}) {
      this.values = { ...options.defaults }
    }

    get(key: string): unknown {
      return this.values[key]
    }

    set(key: string, value: unknown): void {
      this.values[key] = value
    }

    delete(key: string): void {
      delete this.values[key]
    }

    get store(): Record<string, unknown> {
      return { ...this.values }
    }
  }

  return { default: ElectronStore }
})

import type { AppEvent } from '@shared/app-events'
import type {
  FlowId,
  HubAddressV1,
  InitialPlanDraftInputV1,
} from '@shared/xiaogui-collaboration-hub'
import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { CodingRoleProfileDraftV1 } from '../coding-extensions/role-profile-module'
import type { PiAttemptWorkerPortV1 } from '../agent-runtime/pi-worker-port'
import type { PiRuntimeOptionsV1 } from '../agent-runtime/pi-adapter'
import type { requestWorkerHostTool } from '../../../worker/worker-host-tool-channel'
import {
  createXiaoguiRuntimeCompositionV1,
  type XiaoguiRuntimeCompositionV1,
} from './runtime-composition'

const TEST_ROOT = 'E:\\XiaoguiInternalCandidate\\hub-runtime-01-pi-20260910'
const PROJECT_ID = `xgp1_${'3'.repeat(64)}`
const SESSION_KEY = `xgs1_${'4'.repeat(64)}`
const ADDRESS = { projectId: PROJECT_ID, sessionKey: SESSION_KEY } as HubAddressV1
const SOURCE_INSTALLATION = process.cwd()

const roots: string[] = []
const compositions: XiaoguiRuntimeCompositionV1[] = []

afterEach(async () => {
  for (const composition of compositions.splice(0).reverse()) {
    try {
      await composition.close()
    } catch {
      // Keep cleanup best-effort so a failed assertion does not hide its cause.
    }
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
  vi.restoreAllMocks()
})

describe('Pi production runtime composition', () => {
  it('executes a real Attempt through Pi SDK tools, fixed verification, and Delivery review', async () => {
    const projectRoot = createFixtureProject()
    expect(git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    const userDataDir = tempRoot('composition-user-data-')
    const toolRequests: Array<{
      method: string
      fromCwd: string
      fromSessionId: string
    }> = []
    const modelSelections: string[] = []
    const promptDone = deferred<void>()
    let attemptRoot = ''
    let promptSessionId = ''
    const piWorkerFactory: NonNullable<PiRuntimeOptionsV1['workerFactory']> = (input) => {
      let sessionId: string | undefined
      let sessionFile = ''
      let requestSequence = 0

      const request: typeof requestWorkerHostTool = async (requestInput) => {
        if (!sessionId || !sessionFile) throw new Error('PI_FIXTURE_SESSION_NOT_STARTED')
        const hostRequest: WorkerHostToolRequestV1 = {
          type: 'host-tool-request',
          requestId: `fixture-host-${++requestSequence}`,
          ...requestInput,
        }
        toolRequests.push({
          method: requestInput.method,
          fromCwd: input.rootPath,
          fromSessionId: sessionId,
        })
        return input.onTool({
          request: hostRequest,
          fromCwd: input.rootPath,
          fromPoolKey: input.rootPath,
          sessionFile,
          fromSessionId: sessionId,
        })
      }

      const worker: PiAttemptWorkerPortV1 = {
        async start() {
          sessionId = 'fixture-pi-session-1'
          sessionFile = join(input.rootPath, '.pi', 'fixture-session.jsonl')
          promptSessionId = sessionId
          attemptRoot = input.rootPath
          mkdirSync(join(input.rootPath, '.pi'), { recursive: true })
          return { sessionId, sessionFile, model: 'fixture/model' }
        },
        async setModel(provider, model) {
          modelSelections.push(`${provider}/${model}`)
          return 'fixture/model'
        },
        async prompt() {
          try {
            if (!sessionId) throw new Error('PI_FIXTURE_SESSION_NOT_STARTED')
            const lifecycle = (await import('../../../worker/xiaogui-coding-extensions/attempt-tool-extension')).createPiAttemptToolLifecycleV1({
              attemptId: input.scope.attemptId,
              sourceSessionId: () => sessionId,
              request,
            })
            const read = lifecycle.wrapDefinition(createReadToolDefinition(input.rootPath))
            const write = lifecycle.wrapDefinition(createWriteToolDefinition(input.rootPath))
            const readResult = await read.execute(
              'fixture-pi-read',
              { path: 'src/index.ts' },
              undefined,
              undefined,
              {} as never,
            )
            const readText = readResult.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
            if (!readText.includes('value: number = 1')) throw new Error('PI_FIXTURE_READ_MISMATCH')

            await write.execute(
              'fixture-pi-write',
              { path: 'src/index.ts', content: 'export const value: number = 2\n' },
              undefined,
              undefined,
              {} as never,
            )
            input.onEvent({
              type: 'run',
              phase: 'idle',
              settled: true,
              seq: 1,
              workspaceId: input.scope.projectId,
              sessionId,
              sessionFile,
              runId: 'fixture-pi-run-1',
              turnId: 'fixture-pi-turn-1',
              timestamp: Date.now(),
            } satisfies AppEvent)
            promptDone.resolve()
          } catch (error) {
            promptDone.reject(error)
            throw error
          }
        },
        async abort() {},
        async close() {},
      }
      return worker
    }

    const composition = track(createXiaoguiRuntimeCompositionV1({
      userDataDir,
      productionEnabled: false,
      lookup: {
        lookup: async () => ({
          kind: 'FOUND' as const,
          scope: { ...ADDRESS, sessionMode: 'CODING' as const },
        }),
      },
      projectResolver: { resolveProjectRoot: () => projectRoot },
      codingPermissionModeProvider: () => 'AUTO_APPROVE',
      piWorkerFactory,
    }))

    const planStart = await composition.application.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'pi-composition-flow-start',
      intent: {
        type: 'flow.start.with_draft',
        draft: draft(),
      },
    })
    expect(planStart.ok).toBe(true)
    if (!planStart.ok || !planStart.value.flowId || !planStart.value.revisionId) {
      throw new Error('PI_COMPOSITION_FLOW_START_FAILED')
    }
    const flowId = planStart.value.flowId as FlowId

    const planProjection = await composition.application.observe(ADDRESS)
    if (!planProjection.ok || !planProjection.value.activeRevision) {
      throw new Error('PI_COMPOSITION_PLAN_MISSING')
    }
    await expect(composition.application.execute({
      contractVersion: 'm2a.v1',
      address: ADDRESS,
      trustedActor: { kind: 'main-process-user' },
      requestId: 'pi-composition-flow-approve',
      expectedSessionVersion: planProjection.value.sessionVersion,
      intent: {
        type: 'plan.revision.submit',
        flowId,
        baseRevisionId: planStart.value.revisionId,
        draft: planProjection.value.activeRevision.draft,
      },
    })).resolves.toMatchObject({ ok: true })

    const prepared = await composition.taskExecution.start({
      address: ADDRESS,
      flowId,
      prompt: '读取并更新已经批准的 TypeScript 文件，然后完成固定类型检查。',
      files: [{ operation: 'MODIFY', relativePath: 'src/index.ts' }],
    })
    if (!prepared.ok) throw new Error(`PI_COMPOSITION_ATTEMPT_PREPARE_FAILED:${JSON.stringify(prepared)}`)
    expect(prepared).toMatchObject({ ok: true, value: { attempt: { status: 'READY' } } })

    const attemptId = prepared.value.attempt.attemptId
    const taskRunId = prepared.value.taskRun.taskRunId
    const role = composition.codingRoles.upsert(fixtureRole())
    expect(role.modelSelector).toBe('fixture/model')
    expect(composition.codingRoles.bindAttempt(attemptId, role.profileId).snapshot.role).toBe('IMPLEMENT')

    const pendingPlan = composition.codingPlan.getProjection(attemptId)
    if (!pendingPlan) throw new Error('PI_COMPOSITION_ATTEMPT_PLAN_MISSING')
    const approvedPlan = composition.codingPlan.approve({
      schemaVersion: 1,
      attemptId,
      expectedRevision: pendingPlan.plan.revision,
      expectedPlanDigest: pendingPlan.planDigest,
    })
    expect(approvedPlan).toMatchObject({ ok: true, projection: { state: 'APPROVED' } })

    await expect(composition.taskExecution.resumeAttempt(ADDRESS, attemptId)).resolves.toMatchObject({
      ok: true,
      value: { attempt: { attemptId } },
    })
    await withTimeout(promptDone.promise, 30_000)
    await vi.waitFor(async () => {
      const projection = await composition.application.observeM2B(ADDRESS)
      if (!projection.ok) throw new Error('PI_COMPOSITION_PROJECTION_UNAVAILABLE')
      const attempt = projection.value.attempts.find((candidate) => candidate.attemptId === attemptId)
      expect(attempt?.status).toBe('SUCCEEDED')
    }, { timeout: 30_000, interval: 100 })

    expect(modelSelections).toEqual(['fixture/model'])
    expect(promptSessionId).toBe('fixture-pi-session-1')
    expect(toolRequests.map((request) => request.method)).toEqual([
      'xiaogui.taskhub.pi.tool.begin',
      'xiaogui.taskhub.pi.tool.settle',
      'xiaogui.taskhub.pi.tool.begin',
      'xiaogui.taskhub.pi.tool.settle',
    ])
    expect(toolRequests.every((request) => request.fromCwd === attemptRoot)).toBe(true)
    expect(toolRequests.every((request) => request.fromSessionId === promptSessionId)).toBe(true)
    expect(readFileSync(join(projectRoot, 'src', 'index.ts'), 'utf8')).toBe('export const value: number = 1\n')
    expect(readFileSync(join(attemptRoot, 'src', 'index.ts'), 'utf8')).toBe('export const value: number = 2\n')

    const delivery = await composition.delivery.selectTasks(ADDRESS, {
      requestId: 'pi-composition-delivery-select',
      flowId,
      taskRunIds: [taskRunId],
    })
    expect(delivery).toMatchObject({ ok: true, value: { state: 'READY_FOR_REVIEW' } })
    expect(composition.delivery.readLatestDelivery(ADDRESS, flowId)).toMatchObject({
      state: 'READY_FOR_REVIEW',
      selectedTaskRunIds: [taskRunId],
    })
    const auditDb = new DatabaseSync(join(userDataDir, 'xiaogui-task-hub-m2a.sqlite'), { readOnly: true })
    const auditRows = auditDb
      .prepare('select rule_digest, decision from xiaogui_coding_permission_audit_v1 order by rowid')
      .all() as unknown as Array<{ rule_digest: string; decision: string }>
    auditDb.close()
    expect(auditRows).toHaveLength(2)
    expect(auditRows.map((row) => row.rule_digest).sort()).toEqual([
      permissionRuleDigest('READ'),
      permissionRuleDigest('WRITE'),
    ].sort())
    expect(auditRows.every((row) => row.decision === 'MODE_POLICY_AUTO_ALLOWED')).toBe(true)
    const runtimeDb = new DatabaseSync(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-execution-inputs.sqlite'), { readOnly: true })
    const runtimeRow = runtimeDb
      .prepare('select data_json from pi_attempt_runtime_v1 limit 1')
      .get() as unknown as { data_json: string }
    runtimeDb.close()
    const runtimeEvidence = JSON.parse(runtimeRow.data_json) as {
      events: Array<{ type: string; permissionPurpose?: string }>
      calls: Record<string, { state: string }>
    }
    expect(runtimeEvidence.events
      .filter((event) => event.type === 'PERMISSION_REQUESTED')
      .map((event) => event.permissionPurpose)).toEqual(['FILE_READ', 'FILE_WRITE'])
    expect(Object.values(runtimeEvidence.calls).map((call) => call.state)).toEqual(['SETTLED', 'SETTLED'])
    expect(readFileSync(join(projectRoot, 'src', 'index.ts'), 'utf8')).toBe('export const value: number = 1\n')
    expect(existsSync(join(userDataDir, 'xiaogui', 'agent-runtime'))).toBe(false)
  }, 120_000)
})

function createFixtureProject(): string {
  const projectRoot = tempRoot('pi-production-project-')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'index.ts'), 'export const value: number = 1\n', 'utf8')
  writeFileSync(join(projectRoot, 'tsconfig.web.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2), 'utf8')
  writeFileSync(join(projectRoot, 'tsconfig.node.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2), 'utf8')
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'pi-production-fixture', private: true, type: 'module' }), 'utf8')
  writeFileSync(join(projectRoot, '.gitignore'), 'node_modules/\n', 'utf8')
  git(projectRoot, ['init'])
  git(projectRoot, ['config', 'core.autocrlf', 'false'])
  git(projectRoot, ['config', 'core.eol', 'lf'])
  git(projectRoot, ['config', 'user.email', 'xiaogui@example.test'])
  git(projectRoot, ['config', 'user.name', 'Xiaogui Test'])
  git(projectRoot, ['add', '.'])
  git(projectRoot, ['commit', '-m', 'fixture baseline'])
  copyTrustedTypeScript(projectRoot)
  return projectRoot
}

function copyTrustedTypeScript(projectRoot: string): void {
  const sourcePackage = join(SOURCE_INSTALLATION, 'node_modules', 'typescript')
  if (!existsSync(sourcePackage)) throw new Error('PI_FIXTURE_TYPESCRIPT_PACKAGE_MISSING')
  const nodeModules = join(projectRoot, 'node_modules')
  cpSync(sourcePackage, join(nodeModules, 'typescript'), { recursive: true })
  const sourceBin = join(SOURCE_INSTALLATION, 'node_modules', '.bin')
  const targetBin = join(nodeModules, '.bin')
  mkdirSync(targetBin, { recursive: true })
  for (const file of ['tsc', 'tsc.cmd', 'tsc.ps1']) {
    copyFileSync(join(sourceBin, file), join(targetBin, file))
  }
}

function fixtureRole(): CodingRoleProfileDraftV1 {
  return {
    schemaVersion: 1,
    profileId: 'role.fixture.implement',
    role: 'IMPLEMENT',
    name: 'Fixture Implement',
    description: '真实 Pi SDK composition fixture',
    systemPrompt: '只修改测试批准的 TypeScript 文件。',
    modelSelector: 'fixture/model',
    runtimePolicyId: 'approved.default',
    toolAllowlist: ['read', 'write'],
  }
}

function permissionRuleDigest(operation: 'READ' | 'WRITE'): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    operation,
    relativePaths: ['src/index.ts'],
    dataEgress: 'NONE',
  })).digest('hex')}`
}

function draft(): InitialPlanDraftInputV1 {
  return {
    objective: '通过真实 Pi SDK 修改并验证 TypeScript 文件',
    tasks: [{ taskKey: 'change-ts', title: '修改 TypeScript fixture' }],
  }
}

function tempRoot(prefix: string): string {
  mkdirSync(TEST_ROOT, { recursive: true })
  const root = mkdtempSync(join(TEST_ROOT, prefix))
  roots.push(root)
  return root
}

function track(composition: XiaoguiRuntimeCompositionV1): XiaoguiRuntimeCompositionV1 {
  compositions.push(composition)
  return composition
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PI_COMPOSITION_TEST_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
