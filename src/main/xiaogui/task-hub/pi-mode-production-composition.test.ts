import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  LoadExtensionsResult,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppEvent } from '@shared/app-events'
import type {
  FlowId,
  HubAddressV1,
} from '@shared/xiaogui-collaboration-hub'
import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { WorkReportDraftV1 } from '@shared/xiaogui-work-report-docx'
import type { CodingRoleProfileDraftV1 } from '../coding-extensions/role-profile-module'
import type { PiAttemptWorkerPortV1 } from '../agent-runtime/pi-worker-port'
import type { PiRuntimeOptionsV1 } from '../agent-runtime/pi-adapter'
import type { requestWorkerHostTool } from '../../../worker/worker-host-tool-channel'
import { addXiaoguiWorkReportDocxTool, XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME } from '../../../worker/xiaogui-work-report-docx-tool'
import { createPiAttemptToolLifecycleV1 } from '../../../worker/xiaogui-coding-extensions/attempt-tool-extension'
import { inspectSafeDocxArchiveV1 } from '../docx-safety'
import {
  createXiaoguiRuntimeCompositionV1,
  type XiaoguiRuntimeCompositionV1,
} from './runtime-composition'

// The composition reaches the desktop config boundary while this test runs
// in Node; keep that host-only persistence seam local to the fixture.
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

const requestWorkerHostToolMock = vi.hoisted(() => vi.fn())

vi.mock('../../../worker/worker-host-tool-channel.js', () => ({
  requestWorkerHostTool: requestWorkerHostToolMock,
}))

const TEST_ROOT = 'E:\\XiaoguiInternalCandidate\\hub-runtime-01-pi-20260910'
const DESIGN_FIXTURE_ROOT = join(TEST_ROOT, 'design-private-2d7')
const DESIGN_RUNTIME_SOURCE = join(DESIGN_FIXTURE_ROOT, 'source')
const DESIGN_RUNTIME_MANIFEST = join(DESIGN_RUNTIME_SOURCE, 'runtime-manifest.json')
const DESIGN_PYTHON = 'C:\\Users\\90662\\AppData\\Local\\Programs\\XiaoguiInternalRC-4511fc3\\resources\\libreoffice\\program\\python.exe'
const PROJECT_ID = `xgp1_${'5'.repeat(64)}`
const SESSION_KEY = `xgs1_${'6'.repeat(64)}`
const ADDRESS = { projectId: PROJECT_ID, sessionKey: SESSION_KEY } as HubAddressV1
const roots: string[] = []
const compositions: XiaoguiRuntimeCompositionV1[] = []

afterEach(async () => {
  for (const composition of compositions.splice(0).reverse()) {
    try {
      await composition.close()
    } catch {
      // Keep cleanup best-effort so a failed assertion remains visible.
    }
  }
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
  requestWorkerHostToolMock.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Pi WORK/DESIGN production composition', () => {
  it('runs a WORK report tool through the Attempt and delivers a real DOCX without tsc', async () => {
    const projectRoot = createFixtureProject('work')
    const userDataDir = tempRoot('work-user-data-')
    const promptDone = deferred<void>()
    const toolCalls: WorkerHostToolRequestV1[] = []
    const modelSelections: string[] = []
    const promptRuns = { count: 0 }
    const workerFactory = createFixtureWorkerFactory({
      mode: 'WORK',
      promptDone,
      toolCalls,
      modelSelections,
      promptRuns,
      prompt: async ({ input, sessionId, requestHostTool }) => {
        const lifecycle = createPiAttemptToolLifecycleV1({
          attemptId: input.scope.attemptId,
          sourceSessionId: () => sessionId,
          request: requestHostTool,
        })
        const read = lifecycle.wrapDefinition(createReadToolDefinition(input.rootPath))
        const readResult = await read.execute(
          'fixture-work-project-read',
          { path: 'PROJECT.md' },
          undefined,
          undefined,
          {} as never,
        )
        const readText = readResult.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        if (!readText.includes('WORK fixture')) throw new Error('WORK_PROJECT_READ_MISMATCH')

        const loaded = addXiaoguiWorkReportDocxTool(
          { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult,
          {
            getSourceSessionId: () => sessionId,
            getSourceRunId: () => 'fixture-work-run-1',
          },
        )
        const definition = loaded.extensions[0]?.tools
          .get(XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME)?.definition
        if (!definition) throw new Error('WORK_REPORT_TOOL_MISSING')
        const result = await definition.execute(
          'fixture-work-report',
          { action: 'PREPARE', draft: workReportDraft() },
          undefined,
          undefined,
          {} as never,
        )
        const details = result.details as { kind?: unknown } | undefined
        if (details?.kind !== 'XIAOGUI_WORK_REPORT_DOCX_ATTEMPT_ARTIFACT') {
          throw new Error('WORK_REPORT_ARTIFACT_MISSING')
        }
        return undefined
      },
    })
    const composition = track(createXiaoguiRuntimeCompositionV1({
      userDataDir,
      productionEnabled: false,
      lookup: lookup('WORK'),
      projectResolver: { resolveProjectRoot: () => projectRoot },
      codingPermissionModeProvider: () => 'AUTO_APPROVE',
      piWorkerFactory: workerFactory,
    }))

    const { flowId } = await startAndApprovePlan(composition, 'WORK')
    const prepared = await composition.taskExecution.start({
      address: ADDRESS,
      flowId,
        prompt: '使用标准报告工具生成一份最小工作报告。',
        files: [
          { operation: 'MODIFY', relativePath: 'PROJECT.md' },
          { operation: 'CREATE', relativePath: 'reports/report.docx' },
      ],
    })
    if (!prepared.ok) throw new Error(`WORK_ATTEMPT_PREPARE_FAILED:${JSON.stringify(prepared)}`)
    const attemptId = prepared.value.attempt.attemptId
    const taskRunId = prepared.value.taskRun.taskRunId
    bindAndApproveAttemptPlan(composition, attemptId, 'WORK')

    await expect(composition.taskExecution.resumeAttempt(ADDRESS, attemptId)).resolves.toMatchObject({ ok: true })
    await withTimeout(promptDone.promise, 45_000)
    await waitForSucceeded(composition, attemptId)

    const attemptRoot = await attemptRootFromRuntime(userDataDir)
    const reportPath = join(attemptRoot, 'reports', 'report.docx')
    expect(existsSync(reportPath)).toBe(true)
    const report = readFileSync(reportPath)
    await expect(inspectSafeDocxArchiveV1(report)).resolves.toMatchObject({ entryCount: expect.any(Number) })
    expect(readFileSync(join(projectRoot, 'PROJECT.md'), 'utf8')).toContain('WORK fixture')
    expect(modelSelections).toEqual(['fixture/model'])
    expect(toolCalls.map((call) => call.method)).toEqual([
      'xiaogui.taskhub.pi.tool.begin',
      'xiaogui.taskhub.pi.tool.settle',
      'xiaogui.work.report-docx.v1',
    ])
    expect(toolCalls.every((call) => call.payload.sourceSessionId === 'fixture-work-session-1')).toBe(true)
    const workRuntimeEvidence = runtimeEvidenceFrom(userDataDir)
    expect(workRuntimeEvidence.events
      .filter((event) => event.type === 'PERMISSION_REQUESTED')
      .map((event) => event.permissionPurpose)).toEqual(['FILE_READ', 'FILE_WRITE'])
    expect(Object.values(workRuntimeEvidence.calls).every((call) => call.state === 'SETTLED')).toBe(true)

    const delivery = await composition.delivery.selectTasks(ADDRESS, {
      requestId: 'pi-work-delivery-select',
      flowId,
      taskRunIds: [taskRunId],
    })
    expect(delivery).toMatchObject({ ok: true, value: { state: 'READY_FOR_REVIEW' } })
    expect(composition.delivery.readLatestDelivery(ADDRESS, flowId)).toMatchObject({
      state: 'READY_FOR_REVIEW',
      selectedTaskRunIds: [taskRunId],
    })
    const beforeRestart = await composition.application.observeM2B(ADDRESS)
    if (!beforeRestart.ok) throw new Error('WORK_RESTART_BASELINE_PROJECTION_MISSING')
    expect(beforeRestart.value.authoritativeMode).toBe('WORK')
    expect(beforeRestart.value.attempts.find((candidate) => candidate.attemptId === attemptId)).toMatchObject({
      attemptId, status: 'SUCCEEDED',
    })
    await composition.close()
    const restored = track(createXiaoguiRuntimeCompositionV1({
      userDataDir,
      productionEnabled: false,
      lookup: lookup('WORK'),
      projectResolver: { resolveProjectRoot: () => projectRoot },
      codingPermissionModeProvider: () => 'AUTO_APPROVE',
      piWorkerFactory: workerFactory,
    }))
    await restored.taskExecution.recover()
    const afterRestart = await restored.application.observeM2B(ADDRESS)
    if (!afterRestart.ok) throw new Error('WORK_RESTART_PROJECTION_MISSING')
    expect(afterRestart.value).toMatchObject({ sessionMode: 'WORK', authoritativeMode: 'WORK' })
    expect(afterRestart.value.attempts.find((candidate) => candidate.attemptId === attemptId)).toMatchObject({
      attemptId, status: 'SUCCEEDED',
    })
    expect(restored.delivery.readLatestDelivery(ADDRESS, flowId)).toMatchObject({
      state: 'READY_FOR_REVIEW',
      selectedTaskRunIds: [taskRunId],
    })
    expect(promptRuns.count).toBe(1)
    expect(existsSync(join(userDataDir, 'xiaogui', 'agent-runtime'))).toBe(false)
  }, 120_000)

  it('runs DESIGN open through the deployed sidecar and delivers a safe overview without tsc', async () => {
    expect(existsSync(DESIGN_RUNTIME_SOURCE)).toBe(true)
    expect(existsSync(DESIGN_RUNTIME_MANIFEST)).toBe(true)
    expect(existsSync(DESIGN_PYTHON)).toBe(true)
    const runtimeManifest = JSON.parse(readFileSync(DESIGN_RUNTIME_MANIFEST, 'utf8')) as {
      files?: unknown[]
    }
    expect(runtimeManifest.files).toHaveLength(39)
    vi.stubEnv('XIAOGUI_RUNTIME_DIR', '')
    vi.stubEnv('XIAOGUI_REPO', DESIGN_RUNTIME_SOURCE)
    vi.stubEnv('XIAOGUI_PYTHON', DESIGN_PYTHON)

    const projectRoot = createFixtureProject('design')
    const userDataDir = tempRoot('design-user-data-')
    const promptDone = deferred<void>()
    const toolCalls: WorkerHostToolRequestV1[] = []
    const modelSelections: string[] = []
    const promptRuns = { count: 0 }
    const workerFactory = createFixtureWorkerFactory({
      mode: 'DESIGN',
      promptDone,
      toolCalls,
      modelSelections,
      promptRuns,
      prompt: async ({ input, sessionId, requestHostTool }) => {
        if (!input.designExtensionPath) throw new Error('DESIGN_EXTENSION_PATH_MISSING')
        const sdk = await import('@earendil-works/pi-coding-agent')
        const sourceDirectory = dirname(input.designExtensionPath)
        const loaded = await sdk.discoverAndLoadExtensions(
          [input.designExtensionPath],
          sourceDirectory,
          sourceDirectory,
        )
        if (loaded.errors.length !== 0) throw new Error('DESIGN_EXTENSION_LOAD_FAILED')
        const privateDefinition = loaded.extensions.flatMap((extension) => [...extension.tools.values()])
          .find((tool) => tool.definition.name === 'design_project')?.definition
        if (!privateDefinition) throw new Error('DESIGN_PRIVATE_DEFINITION_MISSING')
        const controlledDefinition: ToolDefinition = {
          ...privateDefinition,
          async execute(toolCallId, params, signal) {
            const action = (params as { action?: unknown } | null)?.action
            if (action !== 'open') throw new Error('DESIGN_ACTION_NOT_SUPPORTED_IN_FIXTURE')
            const outcome = await requestHostTool({
              method: 'xiaogui.taskhub.design-project',
              payload: {
                attemptId: input.scope.attemptId,
                sourceSessionId: sessionId,
                toolCallId,
                action: 'open',
              },
            }, signal)
            if (!outcome.ok || outcome.value.kind !== 'PI_DESIGN_PROJECT_ARTIFACT') {
              throw new Error(`DESIGN_PROJECT_ARTIFACT_MISSING:${JSON.stringify(outcome)}`)
            }
            return {
              content: [{ type: 'text', text: outcome.value.summary }],
              details: outcome.value,
            }
          },
        }
        const result = await controlledDefinition.execute(
          'fixture-design-open',
          { action: 'open' },
          undefined,
          undefined,
          {} as never,
        )
        if (!result.details || (result.details as { kind?: unknown }).kind !== 'PI_DESIGN_PROJECT_ARTIFACT') {
          throw new Error('DESIGN_PROJECT_RESULT_MISMATCH')
        }
        return undefined
      },
    })
    const composition = track(createXiaoguiRuntimeCompositionV1({
      userDataDir,
      productionEnabled: false,
      lookup: lookup('DESIGN'),
      projectResolver: { resolveProjectRoot: () => projectRoot },
      codingPermissionModeProvider: () => 'AUTO_APPROVE',
      piWorkerFactory: workerFactory,
    }))

    const { flowId } = await startAndApprovePlan(composition, 'DESIGN')
    const prepared = await composition.taskExecution.start({
      address: ADDRESS,
      flowId,
        prompt: '打开项目并生成受控项目概览。',
        files: [
          { operation: 'MODIFY', relativePath: 'PROJECT.md' },
          { operation: 'CREATE', relativePath: 'reports/overview.json' },
      ],
    })
    if (!prepared.ok) throw new Error(`DESIGN_ATTEMPT_PREPARE_FAILED:${JSON.stringify(prepared)}`)
    const attemptId = prepared.value.attempt.attemptId
    const taskRunId = prepared.value.taskRun.taskRunId
    bindAndApproveAttemptPlan(composition, attemptId, 'DESIGN')

    await expect(composition.taskExecution.resumeAttempt(ADDRESS, attemptId)).resolves.toMatchObject({ ok: true })
    await withTimeout(promptDone.promise, 60_000)
    await waitForSucceeded(composition, attemptId)

    const attemptRoot = await attemptRootFromRuntime(userDataDir)
    const overviewPath = join(attemptRoot, 'reports', 'overview.json')
    expect(existsSync(overviewPath)).toBe(true)
    const overview = JSON.parse(readFileSync(overviewPath, 'utf8')) as Record<string, unknown>
    expect(overview).toMatchObject({
      kind: 'DESIGN_PROJECT_OVERVIEW_V1',
      status: 'ok',
      source_version: expect.any(String),
      trace_id: expect.any(String),
      sources: [{ path: 'PROJECT.md', sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }],
    })
    expect(JSON.stringify(overview)).not.toMatch(/[A-Z]:[\\/]/)
    expect(modelSelections).toEqual(['fixture/model'])
    expect(toolCalls.some((call) => call.method === 'xiaogui.taskhub.design-project' && call.payload.action === 'open')).toBe(true)
    expect(toolCalls.filter((call) => call.method === 'xiaogui.taskhub.design-project')).toHaveLength(1)
    expect(readFileSync(join(projectRoot, 'PROJECT.md'), 'utf8')).toContain('DESIGN fixture')
    const designRuntimeEvidence = runtimeEvidenceFrom(userDataDir)
    expect(designRuntimeEvidence.events
      .filter((event) => event.type === 'PERMISSION_REQUESTED')
      .map((event) => event.permissionPurpose)).toEqual(['FILE_READ', 'FILE_WRITE'])
    expect(Object.values(designRuntimeEvidence.calls).every((call) => call.state === 'SETTLED')).toBe(true)

    const delivery = await composition.delivery.selectTasks(ADDRESS, {
      requestId: 'pi-design-delivery-select',
      flowId,
      taskRunIds: [taskRunId],
    })
    expect(delivery).toMatchObject({ ok: true, value: { state: 'READY_FOR_REVIEW' } })
    expect(composition.delivery.readLatestDelivery(ADDRESS, flowId)).toMatchObject({
      state: 'READY_FOR_REVIEW',
      selectedTaskRunIds: [taskRunId],
    })
    const beforeRestart = await composition.application.observeM2B(ADDRESS)
    if (!beforeRestart.ok) throw new Error('DESIGN_RESTART_BASELINE_PROJECTION_MISSING')
    expect(beforeRestart.value.authoritativeMode).toBe('DESIGN')
    expect(beforeRestart.value.attempts.find((candidate) => candidate.attemptId === attemptId)).toMatchObject({
      attemptId, status: 'SUCCEEDED',
    })
    await composition.close()
    const restored = track(createXiaoguiRuntimeCompositionV1({
      userDataDir,
      productionEnabled: false,
      lookup: lookup('DESIGN'),
      projectResolver: { resolveProjectRoot: () => projectRoot },
      codingPermissionModeProvider: () => 'AUTO_APPROVE',
      piWorkerFactory: workerFactory,
    }))
    await restored.taskExecution.recover()
    const afterRestart = await restored.application.observeM2B(ADDRESS)
    if (!afterRestart.ok) throw new Error('DESIGN_RESTART_PROJECTION_MISSING')
    expect(afterRestart.value).toMatchObject({ sessionMode: 'DESIGN', authoritativeMode: 'DESIGN' })
    expect(afterRestart.value.attempts.find((candidate) => candidate.attemptId === attemptId)).toMatchObject({
      attemptId, status: 'SUCCEEDED',
    })
    expect(restored.delivery.readLatestDelivery(ADDRESS, flowId)).toMatchObject({
      state: 'READY_FOR_REVIEW',
      selectedTaskRunIds: [taskRunId],
    })
    expect(promptRuns.count).toBe(1)
    expect(existsSync(join(userDataDir, 'xiaogui', 'agent-runtime'))).toBe(false)
  }, 180_000)
})

interface FixtureWorkerOptions {
  readonly mode: 'WORK' | 'DESIGN'
  readonly promptDone: Deferred<void>
  readonly toolCalls: WorkerHostToolRequestV1[]
  readonly modelSelections: string[]
  readonly promptRuns?: { count: number }
  readonly prompt: (input: {
    input: Parameters<NonNullable<PiRuntimeOptionsV1['workerFactory']>>[0]
    sessionId: string
    requestHostTool: typeof requestWorkerHostTool
  }) => Promise<void>
}

function createFixtureWorkerFactory(
  options: FixtureWorkerOptions,
): NonNullable<PiRuntimeOptionsV1['workerFactory']> {
  return (input) => {
    let sessionId: string | undefined
    let sessionFile = ''
    let requestSequence = 0
    const requestHostTool: typeof requestWorkerHostTool = async (requestInput, signal) => {
      if (!sessionId || !sessionFile) throw new Error('PI_FIXTURE_SESSION_NOT_STARTED')
      const hostRequest: WorkerHostToolRequestV1 = {
        type: 'host-tool-request',
        requestId: `fixture-${options.mode.toLowerCase()}-host-${++requestSequence}`,
        ...requestInput,
      }
      options.toolCalls.push(hostRequest)
      return input.onTool({
        request: hostRequest,
        fromCwd: input.rootPath,
        fromPoolKey: input.rootPath,
        sessionFile,
        fromSessionId: sessionId,
        signal,
      })
    }

    const worker: PiAttemptWorkerPortV1 = {
      async start() {
        sessionId = `fixture-${options.mode.toLowerCase()}-session-1`
        sessionFile = join(input.rootPath, '.pi', 'fixture-session.jsonl')
        mkdirSync(dirname(sessionFile), { recursive: true })
        return { sessionId, sessionFile, model: 'fixture/model' }
      },
      async setModel(provider, model) {
        options.modelSelections.push(`${provider}/${model}`)
        return 'fixture/model'
      },
      async prompt() {
        try {
          if (options.promptRuns) options.promptRuns.count += 1
          if (!sessionId) throw new Error('PI_FIXTURE_SESSION_NOT_STARTED')
          await options.prompt({ input, sessionId, requestHostTool })
          input.onEvent({
            type: 'run',
            phase: 'idle',
            settled: true,
            seq: 1,
            workspaceId: input.scope.projectId,
            sessionId,
            sessionFile,
            runId: `fixture-${options.mode.toLowerCase()}-run-1`,
            turnId: `fixture-${options.mode.toLowerCase()}-turn-1`,
            timestamp: Date.now(),
          } satisfies AppEvent)
          options.promptDone.resolve(undefined)
        } catch (error) {
          options.promptDone.reject(error)
          throw error
        }
      },
      async abort() {},
      async close() {},
    }
    requestWorkerHostToolMock.mockImplementation(requestHostTool)
    return worker
  }
}

function createFixtureProject(mode: 'work' | 'design'): string {
  const root = tempRoot(`mode-project-${mode}-`)
  writeFileSync(join(root, 'PROJECT.md'), `# ${mode.toUpperCase()} fixture\n\nA controlled ${mode} project.\n`, 'utf8')
  mkdirSync(join(root, 'reports'), { recursive: true })
  writeFileSync(join(root, 'reports', '.gitkeep'), '', 'utf8')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
  git(root, ['init'])
  git(root, ['config', 'core.autocrlf', 'false'])
  git(root, ['config', 'core.eol', 'lf'])
  git(root, ['config', 'user.email', 'xiaogui@example.test'])
  git(root, ['config', 'user.name', 'Xiaogui Test'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', `${mode} fixture baseline`])
  expect(git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
  return root
}

function workReportDraft(): WorkReportDraftV1 {
  return {
    title: '最小工作报告',
    sections: [{ heading: '结果', paragraphs: ['WORK 受控报告'], bullets: ['真实 DOCX 结构'] }],
  }
}

function fixtureRole(mode: 'WORK' | 'DESIGN'): CodingRoleProfileDraftV1 {
  return {
    schemaVersion: 1,
    profileId: `role.fixture.${mode.toLowerCase()}`,
    role: 'IMPLEMENT',
    name: `${mode} Fixture Implement`,
    description: `真实 ${mode} Pi production fixture`,
    systemPrompt: `只使用 ${mode} 任务已批准工具。`,
    modelSelector: 'fixture/model',
    runtimePolicyId: 'approved.default',
    toolAllowlist: ['read', 'write'],
  }
}

async function startAndApprovePlan(
  composition: XiaoguiRuntimeCompositionV1,
  mode: 'WORK' | 'DESIGN',
): Promise<{ flowId: FlowId }> {
  const start = await composition.application.execute({
    contractVersion: 'm2a.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' },
    requestId: `pi-${mode.toLowerCase()}-flow-start`,
    intent: {
      type: 'flow.start.with_draft',
      draft: {
        objective: `${mode} 真实生产 composition fixture`,
        tasks: [{ taskKey: `${mode.toLowerCase()}-task`, title: `${mode} 受控任务` }],
      },
    },
  })
  if (!start.ok || !start.value.flowId || !start.value.revisionId) throw new Error(`${mode}_FLOW_START_FAILED`)
  const projection = await composition.application.observe(ADDRESS)
  if (!projection.ok || !projection.value.activeRevision) throw new Error(`${mode}_PLAN_MISSING`)
  const approved = await composition.application.execute({
    contractVersion: 'm2a.v1',
    address: ADDRESS,
    trustedActor: { kind: 'main-process-user' },
    requestId: `pi-${mode.toLowerCase()}-flow-approve`,
    expectedSessionVersion: projection.value.sessionVersion,
    intent: {
      type: 'plan.revision.submit',
      flowId: start.value.flowId,
      baseRevisionId: start.value.revisionId,
      draft: projection.value.activeRevision.draft,
    },
  })
  if (!approved.ok) throw new Error(`${mode}_FLOW_APPROVE_FAILED`)
  return { flowId: start.value.flowId as FlowId }
}

function bindAndApproveAttemptPlan(
  composition: XiaoguiRuntimeCompositionV1,
  attemptId: string,
  mode: 'WORK' | 'DESIGN',
): void {
  const role = composition.codingRoles.upsert(fixtureRole(mode))
  composition.codingRoles.bindAttempt(attemptId, role.profileId)
  const pending = composition.codingPlan.getProjection(attemptId)
  if (!pending) throw new Error('MODE_ATTEMPT_PLAN_MISSING')
  const approved = composition.codingPlan.approve({
    schemaVersion: 1,
    attemptId,
    expectedRevision: pending.plan.revision,
    expectedPlanDigest: pending.planDigest,
  })
  if (!approved.ok) throw new Error('MODE_ATTEMPT_PLAN_APPROVE_FAILED')
}

function lookup(mode: 'WORK' | 'DESIGN') {
  return {
    lookup: async () => ({
      kind: 'FOUND' as const,
      scope: { ...ADDRESS, sessionMode: mode },
    }),
  }
}

async function waitForSucceeded(composition: XiaoguiRuntimeCompositionV1, attemptId: string): Promise<void> {
  await vi.waitFor(async () => {
    const projection = await composition.application.observeM2B(ADDRESS)
    if (!projection.ok) throw new Error('MODE_PROJECTION_UNAVAILABLE')
    const attempt = projection.value.attempts.find((candidate) => candidate.attemptId === attemptId)
    expect(attempt?.status).toBe('SUCCEEDED')
  }, { timeout: 90_000, interval: 100 })
}

async function attemptRootFromRuntime(userDataDir: string): Promise<string> {
  const db = new DatabaseSync(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-execution-inputs.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('select data_json from pi_attempt_runtime_v1 limit 1').get() as unknown as { data_json: string }
    const runtime = JSON.parse(row.data_json) as { sessionFile: string }
    return dirname(dirname(runtime.sessionFile))
  } finally {
    db.close()
  }
}

function runtimeEvidenceFrom(userDataDir: string): {
  events: Array<{ type: string; permissionPurpose?: string }>
  calls: Record<string, { state: string }>
} {
  const db = new DatabaseSync(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-execution-inputs.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('select data_json from pi_attempt_runtime_v1 limit 1').get() as { data_json: string }
    return JSON.parse(row.data_json) as {
      events: Array<{ type: string; permissionPurpose?: string }>
      calls: Record<string, { state: string }>
    }
  } finally {
    db.close()
  }
}

function track(composition: XiaoguiRuntimeCompositionV1): XiaoguiRuntimeCompositionV1 {
  compositions.push(composition)
  return composition
}

function tempRoot(prefix: string): string {
  mkdirSync(TEST_ROOT, { recursive: true })
  const root = mkdtempSync(join(TEST_ROOT, prefix))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value: T) => resolvePromise(value),
    reject: rejectPromise,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PI_MODE_COMPOSITION_TEST_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
