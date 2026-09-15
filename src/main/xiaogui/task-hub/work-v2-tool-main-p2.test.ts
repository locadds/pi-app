import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'
import * as sdk from '@earendil-works/pi-coding-agent'
import type { AppEvent } from '@shared/app-events'
import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import { XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1 } from '@shared/xiaogui-prompt-matrix'
import {
  WORK_REPORT_DOCX_CAPABILITY_V1,
  workerPromptContextToolNamesForModeV1,
} from '@shared/xiaogui-prompt-capabilities'
import type { WorkerHostToolRequestV1 } from '@shared/worker-host-tools'
import type { WorkReportDraftV1 } from '@shared/xiaogui-work-report-docx'
import { Value } from 'typebox/value'
import { afterEach, expect, it, vi } from 'vitest'

import { createInMemoryHubTaskWorkerCredentialsV1 } from '../hub-task/worker-service'
import { createHubTaskWorkerCompositionV1 } from '../hub-task/worker-composition'
import { createInMemoryHubTaskWorkerStateStoreV1 } from '../hub-task/worker-state'
import type { PiAttemptWorkerPortV1 } from '../agent-runtime/pi-worker-port'
import type { PiRuntimeOptionsV1 } from '../agent-runtime/pi-adapter'
import { inspectSafeDocxArchiveV1 } from '../docx-safety'
import {
  addXiaoguiWorkReportDocxTool,
  XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME,
} from '../../../worker/xiaogui-work-report-docx-tool'
import { receiveWorkerHostToolResponse } from '../../../worker/worker-host-tool-channel'
import {
  bindWorkerExecutionIdentityV1,
  clearXiaoguiPromptTurnV1,
  initSession,
  prepareXiaoguiPromptTurnV1,
  st,
} from '../../../worker/worker-runtime'
import {
  createXiaoguiRuntimeCompositionV1,
  type XiaoguiRuntimeCompositionV1,
} from './runtime-composition'

const sendToMainMock = vi.hoisted(() => vi.fn())

vi.mock('../../../worker/worker-transport.js', () => ({ sendToMain: sendToMainMock }))
vi.mock('electron-store', () => ({ default: class {
  private readonly values: Record<string, unknown> = {}
  get(key: string) { return this.values[key] }
  set(key: string, value: unknown) { this.values[key] = value }
  delete(key: string) { delete this.values[key] }
} }))

const roots: string[] = []
const compositions: XiaoguiRuntimeCompositionV1[] = []
const ADDRESS = { projectId: `xgp1_${'7'.repeat(64)}`, sessionKey: `xgs1_${'8'.repeat(64)}` } as HubAddressV1
const PACKAGE = `sha256:${'9'.repeat(64)}`
const TARGET_PATH = 'reports/work-v2-report.docx'
const NOW = '2026-09-16T01:00:00.000Z'

afterEach(async () => {
  for (const composition of compositions.splice(0).reverse()) await composition.close().catch(() => undefined)
  await st.runtime?.dispose().catch(() => undefined)
  st.runtime = null
  st.session = null
  st.sdk = null
  st.sharedEventBus = null
  st.workerExecutionIdentity = null
  st.taskHubAttemptId = undefined
  st.taskHubDesignExtensionPath = undefined
  st.taskHubWorktreeAuthorized = undefined
  st.currentSessionId = ''
  st.currentRunId = ''
  st.promptContext = null
  st.promptContextCandidate = null
  st.promptTurnContext = null
  st.promptPreflight = null
  st.effectivePrompt = null
  st.uiBridge = null
  st.widgetHost?.dispose()
  st.widgetHost = null
  sendToMainMock.mockReset()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it('runs the real SDK WORK report tool through one trusted V2 Main acceptance', async () => {
  const projectRoot = fixtureProject()
  const userDataDir = temp('xiaogui-work-v2-main-user-')
  const agentDir = temp('xiaogui-work-v2-main-agent-')
  const promptDone = deferred<void>()
  const hostRequests: WorkerHostToolRequestV1[] = []
  const sdkSessionPrompts: string[] = []
  const mainPrompts: string[] = []
  let attemptRoot = ''
  let promptCount = 0
  let toolResult: unknown

  const workerFactory: NonNullable<PiRuntimeOptionsV1['workerFactory']> = input => {
    let sessionFile = ''
    const bridgeHostRequest = (message: unknown) => {
      const request = message as WorkerHostToolRequestV1
      if (request?.type !== 'host-tool-request') return
      hostRequests.push(request)
      void input.onTool({
        request,
        fromCwd: input.rootPath,
        fromPoolKey: input.rootPath,
        fromSessionId: st.currentSessionId,
        sessionFile,
      }).then(
        outcome => receiveWorkerHostToolResponse({ type: 'host-tool-response', requestId: request.requestId, outcome }),
        error => receiveWorkerHostToolResponse({ type: 'host-tool-response', requestId: request.requestId,
          outcome: { ok: false, error: { code: 'HOST_TOOL_FAILED', message: String(error) } } }),
      )
    }
    sendToMainMock.mockImplementation(bridgeHostRequest)
    const worker: PiAttemptWorkerPortV1 = {
      async start() {
        expect(input.worktreeAuthorized).toBe(true)
        attemptRoot = input.rootPath
        mkdirSync(agentDir, { recursive: true })
        vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
        st.sdk = sdk
        st.sharedEventBus = sdk.createEventBus()
        st.taskHubAttemptId = input.scope.attemptId
        st.taskHubWorktreeAuthorized = input.worktreeAuthorized
        bindWorkerExecutionIdentityV1({
          authorizedCwd: input.rootPath,
          projectIdentityDigest: `sha256:${'a'.repeat(64)}`,
          slotBindingDigest: `sha256:${'b'.repeat(64)}`,
        })
        await initSession(input.rootPath, workPromptContext(), [])
        if (!st.session) throw new Error('WORK_V2_SDK_SESSION_MISSING')
        const sdkSessionFile = st.session.sessionFile
        if (!sdkSessionFile) throw new Error('WORK_V2_SDK_SESSION_FILE_MISSING')
        sessionFile = sdkSessionFile
        return { sessionId: st.session.sessionId, sessionFile, model: 'fixture/model' }
      },
      async setModel() { return 'fixture/model' },
      async prompt(text) {
        try {
          promptCount += 1
          mainPrompts.push(text)
          prepareXiaoguiPromptTurnV1('生成标准 Word 报告')
          const promptState = st.promptPreflight?.()
          if (!promptState || !st.session) throw new Error('WORK_V2_EFFECTIVE_PROMPT_MISSING')
          expect(st.session.systemPrompt.length).toBeGreaterThan(100)
          expect(promptState.prompt).toContain(st.session.systemPrompt)
          const modelPrompt = vi.spyOn(st.session.agent, 'prompt').mockResolvedValue(undefined)
          const configuredAuth = vi.spyOn(st.session.modelRuntime, 'hasConfiguredAuth').mockReturnValue(true)
          try {
            await st.session.prompt('生成标准 Word 报告', { expandPromptTemplates: false })
          } finally {
            configuredAuth.mockRestore()
            modelPrompt.mockRestore()
          }
          sdkSessionPrompts.push(st.session.systemPrompt)
          expect(st.session.systemPrompt).toBe(promptState.prompt)
          expect(st.session.systemPrompt).toContain('# TaskHub V2 标准 Word 报告协议')
          expect(st.session.systemPrompt).toContain('targetPath')
          expect(st.session.systemPrompt).not.toContain('只有用户下一条消息明确确认才调用 CONFIRM')
          expect(st.session.systemPrompt).not.toContain('如确认继续，请单独回复“确认”')
          expect(st.session.systemPrompt).not.toContain('最小 PREPARE 示例：{"action":"PREPARE","draft"')
          st.currentRunId = 'work-v2-sdk-run-1'
          const definition = st.session.getToolDefinition(XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME)
          if (!definition) throw new Error('WORK_V2_REPORT_TOOL_MISSING')
          expect(Value.Check(definition.parameters, { action: 'PREPARE', targetPath: TARGET_PATH, draft: reportDraft() })).toBe(true)
          expect(Value.Check(definition.parameters, { action: 'PREPARE', draft: reportDraft() })).toBe(false)
          expect(Value.Check(definition.parameters, { action: 'CONFIRM' })).toBe(false)
          expect(definition.description).toContain('无需第二次用户确认')
          toolResult = await definition.execute('work-v2-report-call', {
            action: 'PREPARE', targetPath: TARGET_PATH, draft: reportDraft(),
          } as never, undefined, undefined, undefined as never)
          input.onEvent({
            type: 'run', phase: 'idle', settled: true, seq: 1,
            workspaceId: input.scope.projectId, sessionId: st.currentSessionId,
            sessionFile, runId: st.currentRunId, turnId: 'work-v2-turn-1', timestamp: Date.now(),
          } satisfies AppEvent)
          promptDone.resolve(undefined)
        } catch (error) {
          promptDone.reject(error)
          throw error
        } finally {
          clearXiaoguiPromptTurnV1()
        }
      },
      async abort() {},
      async close() {
        await st.runtime?.dispose()
        st.runtime = null
      },
    }
    return worker
  }

  const composition = createXiaoguiRuntimeCompositionV1({
    userDataDir,
    productionEnabled: false,
    lookup: { lookup: async address => ({ kind: 'FOUND', scope: { ...address, sessionMode: 'WORK' } }) },
    projectResolver: { resolveProjectRoot: () => projectRoot },
    codingPermissionModeProvider: () => 'AUTO_APPROVE',
    piWorkerFactory: workerFactory,
  })
  compositions.push(composition)
  const state = createInMemoryHubTaskWorkerStateStoreV1()
  state.upsertAssignment(assignment(), { subjectId: 'subject-work-v2', nodeId: 'node-work-v2', keyId: 'key-work-v2' })
  state.markOpened('assignment-work-v2', NOW)
  const credentials = createInMemoryHubTaskWorkerCredentialsV1()
  const privateKeyPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  credentials.write({ endpoint: 'http://offline.invalid', accessToken: 'a'.repeat(20), node: {
    subjectId: 'subject-work-v2', nodeId: 'node-work-v2', keyId: 'key-work-v2', deviceToken: 'device', privateKeyPem,
  } })
  const service = createHubTaskWorkerCompositionV1({
    state,
    credentials,
    application: composition.application,
    createPort: () => ({
      downloadAssignment: async () => assignment(),
      submitDecision: async () => assignment('ACCEPTED'),
      submitReceipt: async () => { throw new Error('offline') },
    }) as never,
    acceptAndExecuteV2: composition.acceptAndExecuteTrustedPortV2,
  })

  try {
    const accepted = await service.acceptAndExecuteV2({
      contractVersion: 'hub.accept-execute.v2',
      assignmentId: 'assignment-work-v2',
      address: ADDRESS,
      observedPackageSha256: PACKAGE,
      requestId: 'accept-work-v2-report',
    })
    expect(accepted).toMatchObject({ ok: true, value: { attemptId: expect.any(String) } })
    const attemptId = accepted.ok ? accepted.value.attemptId : undefined
    if (!attemptId) throw new Error('WORK_V2_ATTEMPT_MISSING')
    await withTimeout(promptDone.promise, 30_000)
    await vi.waitFor(async () => {
      const projection = await composition.application.observeM2B(ADDRESS)
      if (!projection.ok) throw new Error(projection.error.code)
      expect(projection.value.attempts.find(candidate => candidate.attemptId === attemptId)?.status).toBe('SUCCEEDED')
    }, { timeout: 30_000, interval: 100 })

    expect(attemptRoot).not.toBe('')
    const reportPath = join(attemptRoot, ...TARGET_PATH.split('/'))
    expect(existsSync(reportPath)).toBe(true)
    await expect(inspectSafeDocxArchiveV1(readFileSync(reportPath))).resolves.toMatchObject({ entryCount: expect.any(Number) })
    expect(existsSync(join(projectRoot, ...TARGET_PATH.split('/')))).toBe(false)
    expect(toolResult).toMatchObject({ details: {
      kind: 'XIAOGUI_WORK_REPORT_DOCX_ATTEMPT_ARTIFACT', relativePath: TARGET_PATH,
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    } })

    expect(promptCount).toBe(1)
    expect(mainPrompts).toHaveLength(1)
    expect(mainPrompts[0]).not.toContain(TARGET_PATH)
    expect(hostRequests).toHaveLength(1)
    expect(hostRequests[0]).toMatchObject({ method: 'xiaogui.work.report-docx.v1', payload: {
      action: 'PREPARE', targetPath: TARGET_PATH, toolCallId: 'work-v2-report-call',
    } })
    expect(hostRequests[0].payload).not.toHaveProperty('files')
    expect(sdkSessionPrompts).toHaveLength(1)

    const record = runtimeRecord(userDataDir)
    expect(record.worktreeAuthorization).toBeDefined()
    expect(record.request).not.toHaveProperty('files')
    expect(JSON.stringify(record.request)).not.toContain(TARGET_PATH)
    expect(record.artifacts).toEqual([{
      path: TARGET_PATH,
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      kind: 'WORK_REPORT_DOCX',
    }])
    expect(record.events.filter(event => event.type === 'PERMISSION_REQUESTED')
      .map(event => event.permissionPurpose)).toEqual([])
    expect(record.calls['work-v2-report-call']).toMatchObject({ state: 'SETTLED' })

    const v1Loaded = addXiaoguiWorkReportDocxTool(
      { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult,
      { getSourceSessionId: () => 'v1-session', getSourceRunId: () => 'v1-run' },
    )
    const v1Definition = v1Loaded.extensions[0]?.tools.get(XIAOGUI_WORK_REPORT_DOCX_TOOL_NAME)?.definition
    if (!v1Definition) throw new Error('WORK_V1_REPORT_TOOL_MISSING')
    expect(Value.Check(v1Definition.parameters, { action: 'PREPARE', draft: reportDraft() })).toBe(true)
    expect(Value.Check(v1Definition.parameters, { action: 'CONFIRM' })).toBe(true)
    expect(v1Definition.description).toContain('用户下一条消息确认后另存')
    expect(WORK_REPORT_DOCX_CAPABILITY_V1.minimumEffect).toBe('CONFIRMATION_GATED_PERSISTENT')
    expect(WORK_REPORT_DOCX_CAPABILITY_V1.promptLayer.content).toContain('只有用户下一条消息明确确认才 CONFIRM')
    expect(WORK_REPORT_DOCX_CAPABILITY_V1.promptLayer.content).not.toContain('TaskHub V2')
  } finally {
    service.close()
  }
}, 60_000)

function assignment(decisionState: 'PENDING' | 'ACCEPTED' = 'PENDING') {
  return {
    assignment: {
      assignmentId: 'assignment-work-v2', taskId: 'task-work-v2', decisionState,
      deliveryState: 'OPENED' as const, executionState: 'NOT_STARTED' as const,
      createdAt: NOW, updatedAt: NOW,
    },
    offer: {
      taskId: 'task-work-v2', mode: 'DIRECT' as const,
      title: '生成标准 Word 报告',
      taskContent: '根据任务要求生成一份标准 Word 报告。',
      constraints: ['只在受控 Attempt 工作树生成产物'],
      acceptanceRequirements: ['DOCX结构安全且产物已登记'],
      attachmentRefs: [], packageSha256: PACKAGE,
    },
  }
}

function workPromptContext() {
  return {
    schemaVersion: 1 as const,
    mode: 'WORK' as const,
    phase: 'EXECUTE' as const,
    workspaceAvailable: true,
    projectTrusted: true,
    projectId: ADDRESS.projectId,
    sessionKey: ADDRESS.sessionKey,
    enabledCapabilities: [...XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1.WORK],
    availableToolNames: [...workerPromptContextToolNamesForModeV1('WORK')],
  }
}

function reportDraft(): WorkReportDraftV1 {
  return {
    title: 'TaskHub V2 工作报告',
    sections: [{ heading: '完成情况', paragraphs: ['报告由真实 SDK 工具生成。'], bullets: ['Main 已登记产物'] }],
  }
}

function fixtureProject(): string {
  const root = temp('xiaogui-work-v2-main-project-')
  writeFileSync(join(root, 'PROJECT.md'), '# WORK V2 fixture\n', 'utf8')
  writeFileSync(join(root, '.gitignore'), '.pi/\nnode_modules/\n', 'utf8')
  git(root, ['init'])
  git(root, ['config', 'core.autocrlf', 'false'])
  git(root, ['config', 'user.email', 'xiaogui@example.test'])
  git(root, ['config', 'user.name', 'Xiaogui Test'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'WORK V2 fixture baseline'])
  return root
}

function runtimeRecord(userDataDir: string): {
  request: Record<string, unknown>
  worktreeAuthorization?: Record<string, unknown>
  artifacts?: Array<{ path: string; sha256: string; kind: string }>
  events: Array<{ type: string; permissionPurpose?: string }>
  calls: Record<string, { state: string }>
} {
  const db = new DatabaseSync(join(userDataDir, 'xiaogui', 'task-hub', 'attempt-execution-inputs.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('select data_json from pi_attempt_runtime_v1 limit 1').get() as { data_json: string }
    return JSON.parse(row.data_json) as ReturnType<typeof runtimeRecord>
  } finally {
    db.close()
  }
}

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve: value => resolve(value), reject }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('WORK_V2_MAIN_TEST_TIMEOUT')), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
