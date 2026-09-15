import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron-store', () => ({ default: class { get() {} set() {} delete() {} } }))

import type { ArtifactId, EvidenceBundleId, IsoDateTime, QaResultId, Sha256Digest, TaskChangeSetCandidateId, TaskChangeSetId, VerificationAttemptId } from '@shared/xiaogui-task-verification'
import { taskChangeSetDigestV1, type TaskChangeSetV1 } from '@shared/xiaogui-task-verification'
import type { AttemptId, FlowId, HubAddressV1, PlanRevisionId, TaskRunId } from '@shared/xiaogui-collaboration-hub'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import type { RuntimeAdapterSelectionV1, RuntimeCapabilityV1 } from '@shared/xiaogui-agent-runtime'

import { createHubTaskWorkerServiceV1, createInMemoryHubTaskWorkerCredentialsV1 } from '../hub-task/worker-service'
import { createInMemoryHubTaskWorkerStateStoreV1 } from '../hub-task/worker-state'
import { createAgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { ScriptedAgentRuntimeAdapterV1 } from '../agent-runtime/scripted-adapter'
import { createCollaborationHubApplicationV1 } from './application'
import { GitAttemptWorkspaceServiceV1, SqliteAttemptWorkspaceRegistryV1 } from './attempt-workspace'
import { AttemptExecutionInputStoreV1 } from './attempt-execution-input'
import { PrivateRuntimePayloadVaultV1 } from './private-payload-vault'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import { GitExecutionBaselineProviderV1 } from './git-execution-baseline'
import { XiaoguiTaskExecutionOrchestratorV1 } from './execution-orchestrator'
import { DeliveryComposerV2 } from './delivery-composer'
import { MainProcessDeliveryIntegrationWorktreePortV1 } from './delivery-integration-worktree'
import type { AttemptTaskPatchCaptureV2 } from './attempt-workspace'
import { createHubTaskAcceptAndExecuteTrustedPortV2, createMainAttemptWorkspaceBaselineSourceResolverV1 } from './runtime-composition'
import { deliveryTargetFingerprintV1 } from '@shared/xiaogui-delivery'

const roots: string[] = []
const ADDRESS = {
  projectId: `xgp1_${'a'.repeat(64)}`,
  sessionKey: `xgs1_${'b'.repeat(64)}`,
} as SessionAddressV1
const PACKAGE = `sha256:${'c'.repeat(64)}`
const NOW = '2026-09-15T00:00:00.000Z'
const SCRIPTED_SELECTION: RuntimeAdapterSelectionV1 = {
  adapterId: 'single-accept-scripted', runtimeKind: 'OTHER', protocol: 'HEADLESS',
  capabilityDigest: 'sha256:single-accept-scripted', approvalStatus: 'APPROVED_FOR_PRODUCTION',
  diagnosticOnly: false, stream: 'POLL', interrupt: 'BEST_EFFORT', inspect: 'SNAPSHOT',
}
const SCRIPTED_CAPABILITY: RuntimeCapabilityV1 = {
  ...SCRIPTED_SELECTION, health: 'AVAILABLE', canCreateSession: true, canResumeSession: true,
  interactivePermission: 'HOST_MEDIATED',
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('single accept Main V2 seam', () => {
  it('runs trusted worker acceptance through Saga/workspace, captures disk V2, and composes Delivery V2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-main-accept-v2-'))
    roots.push(root)
    const projectRoot = join(root, 'project')
    mkdirSync(join(projectRoot, 'src'), { recursive: true })
    writeFileSync(join(projectRoot, 'src', 'before.txt'), 'before')
    writeFileSync(join(projectRoot, 'src', 'modify.txt'), 'old')
    git(projectRoot, ['init'])
    git(projectRoot, ['config', 'user.email', 'xiaogui@example.test'])
    git(projectRoot, ['config', 'user.name', 'Xiaogui Test'])
    git(projectRoot, ['add', '.'])
    git(projectRoot, ['commit', '-m', 'baseline'])
    const projectResolver = { resolveProjectRoot: async () => projectRoot }
    const userDataDir = join(root, 'user-data')
    mkdirSync(userDataDir, { recursive: true })
    const hubDbPath = join(userDataDir, 'hub.sqlite')
    const workspaceRegistry = new SqliteAttemptWorkspaceRegistryV1({ dbPath: join(userDataDir, 'workspaces.sqlite') })
    const inputStoreRef: { current?: AttemptExecutionInputStoreV1 } = {}
    const attemptWorkspaces = new GitAttemptWorkspaceServiceV1(workspaceRegistry, projectResolver, {
      managedRoot: join(userDataDir, 'attempt-worktrees'),
      baselineSourceResolver: createMainAttemptWorkspaceBaselineSourceResolverV1(hubDbPath, () => inputStoreRef.current),
    })
    const payloadVault = new PrivateRuntimePayloadVaultV1({ dbPath: join(userDataDir, 'payloads.sqlite') })
    const inputStore = new AttemptExecutionInputStoreV1({
      dbPath: join(userDataDir, 'inputs.sqlite'), payloadVault, workspace: attemptWorkspaces,
    })
    inputStoreRef.current = inputStore
    const scripted = new ScriptedAgentRuntimeAdapterV1({
      capabilities: [SCRIPTED_CAPABILITY], createRuntimeSessionId: 'single-accept-runtime',
    })
    const createScripted = scripted.createOrResume.bind(scripted)
    scripted.createOrResume = async (request) => {
      const lease = workspaceRegistry.getLease(request.scope.attemptId)
      if (!lease) throw new Error('SCRIPTED_WORKTREE_MISSING')
      writeFileSync(join(lease.worktreeRoot, 'src', 'modify.txt'), 'new')
      writeFileSync(join(lease.worktreeRoot, 'src', 'created.txt'), 'created')
      rmSync(join(lease.worktreeRoot, 'src', 'before.txt'))
      writeFileSync(join(lease.worktreeRoot, 'src', 'renamed.txt'), 'before')
      return createScripted(request)
    }
    const application = createCollaborationHubApplicationV1({
      lookup: { lookup: async (address) => ({ kind: 'FOUND', scope: { ...address, sessionMode: 'CODING' } }) },
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      agentRuntime: createAgentRuntimeHostV1(scripted), agentSelection: SCRIPTED_SELECTION,
      baselineProvider: new GitExecutionBaselineProviderV1(projectResolver),
      workspaceBridge: inputStore.bridge, runtimePromptVault: inputStore,
    })
    const taskExecution = new XiaoguiTaskExecutionOrchestratorV1({
      dbPath: hubDbPath, application,
      inputStage: {
        stageAttemptInput: (input) => inputStore!.stage(input),
        stageAttemptWorktreeInput: (input) => inputStore!.stageWorktree(input),
      },
      fileScopeResolver: attemptWorkspaces,
    })
    const state = createInMemoryHubTaskWorkerStateStoreV1()
    const detail = assignment('PENDING')
    state.upsertAssignment(detail, { subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1' })
    state.markOpened('assignment-1', NOW)
    const credentials = createInMemoryHubTaskWorkerCredentialsV1()
    credentials.write({ endpoint: 'http://hub.test', accessToken: 'a'.repeat(20), node: {
      subjectId: 'subject-1', nodeId: 'node-1', keyId: 'key-1', deviceToken: 'device', privateKeyPem: 'private',
    } })
    const trustedPort = createHubTaskAcceptAndExecuteTrustedPortV2({
      application, taskExecution, projectResolver,
    })
    let trustedRequest: Parameters<typeof trustedPort.execute>[0] | undefined
    const worker = createHubTaskWorkerServiceV1({
      state, credentials, application,
      createPort: () => ({
        downloadAssignment: async () => assignment('PENDING'),
        submitDecision: async () => assignment('ACCEPTED'),
        submitReceipt: async () => { throw new Error('offline synthetic') },
      }) as never,
      acceptAndExecuteV2: {
        resolveTarget: trustedPort.resolveTarget,
        execute: (request) => { trustedRequest = request; return trustedPort.execute(request) },
      },
      signReceipt: (receipt) => ({ ...receipt, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    })
    try {
      const accepted = await worker.acceptAndExecuteV2({
        contractVersion: 'hub.accept-execute.v2', assignmentId: 'assignment-1', address: ADDRESS,
        observedPackageSha256: PACKAGE, requestId: 'accept-request-1',
      })
      if (!accepted.ok) throw new Error(accepted.code)
      const projection = await application.observeM2B(ADDRESS)
      if (!projection.ok) throw new Error('projection unavailable')
      const attempt = projection.value.attempts[0]
      if (!attempt) throw new Error('attempt missing')
      const worktreeRoot = workspaceRegistry.getLease(attempt.attemptId)?.worktreeRoot
      expect(worktreeRoot).toBeTruthy()
      const capture = await attemptWorkspaces.captureTaskPatchV2(attempt.attemptId)
      expect(capture.changedFiles.map(({ operation, relativePath }) => ({ operation, relativePath }))).toEqual([
        { operation: 'DELETE', relativePath: 'src/before.txt' },
        { operation: 'CREATE', relativePath: 'src/created.txt' },
        { operation: 'MODIFY', relativePath: 'src/modify.txt' },
        { operation: 'CREATE', relativePath: 'src/renamed.txt' },
      ])

      const taskInput = composerInput(capture, accepted.value.flowId as FlowId, attempt.attemptId)
      const baseRevision = capture.privateVerificationContext.baseRevision
      const baselineTreeHash = capture.privateVerificationContext.baselineGitTreeOid
      const target = { projectId: ADDRESS.projectId, baseRevision, baselineTreeHash,
        initialTargetFingerprint: deliveryTargetFingerprintV1({ projectId: ADDRESS.projectId, baseRevision, baselineTreeHash }) }
      const composed = await new DeliveryComposerV2({ integrationWorktree: new MainProcessDeliveryIntegrationWorktreePortV1({
        projectResolver, managedRoot: join(root, 'delivery'), target, batchId: 'xhbd_main_accept_v2',
      }) }).compose({ flowId: taskInput.changeSet.flowId, deliveryBatchId: 'xhbd_main_accept_v2' as never,
        selectionDraftId: 'xhbsd_main_accept_v2' as never, deliveryChangeSetId: 'xhbdcs_main_accept_v2' as never,
        taskInputs: [taskInput], dependencyOrder: [taskInput.changeSet.taskChangeSetId], selectionDigest: digest('selection'),
        target, qaConfigVersion: 'synthetic.v2', createdAt: NOW as IsoDateTime })
      expect(composed).toMatchObject({ ok: true, changeSet: { version: 2 } })
      if (!composed.ok) throw new Error(composed.reasonCode)
      expect(composed.changeSet.fileChanges.map(({ operation, relativePath }) => ({ operation, relativePath }))).toEqual([
        { operation: 'DELETE', relativePath: 'src/before.txt' },
        { operation: 'CREATE', relativePath: 'src/created.txt' },
        { operation: 'MODIFY', relativePath: 'src/modify.txt' },
        { operation: 'CREATE', relativePath: 'src/renamed.txt' },
      ])
      if (!trustedRequest) throw new Error('trusted request missing')
      const hubDb = new DatabaseSync(hubDbPath)
      hubDb.prepare("update task_execution_sagas set phase = 'OUTCOME_UNKNOWN', last_safe_code = 'OUTCOME_UNKNOWN'").run()
      const beforeReplay = hubDb.prepare('select count(*) as count from task_execution_sagas').get() as { count: number }
      await expect(trustedPort.execute(trustedRequest)).resolves.toEqual({ ok: false, code: 'EXECUTION_OUTCOME_UNKNOWN' })
      const afterReplay = hubDb.prepare('select count(*) as count from task_execution_sagas').get() as { count: number }
      expect(afterReplay.count).toBe(beforeReplay.count)
      hubDb.close()
    } finally {
      worker.close()
      await taskExecution.close()
      application.close()
      inputStore.close()
      payloadVault.close()
      workspaceRegistry.close()
    }
  }, 30_000)
})

function assignment(decisionState: 'PENDING' | 'ACCEPTED') {
  return { assignment: { assignmentId: 'assignment-1', taskId: 'task-1', decisionState, deliveryState: 'OPENED' as const,
    executionState: 'NOT_STARTED' as const, createdAt: NOW, updatedAt: NOW }, offer: { taskId: 'task-1', mode: 'DIRECT' as const,
    title: '创建文件', taskContent: '在 src 下创建 after.txt', constraints: [], acceptanceRequirements: ['文件存在'],
    attachmentRefs: [], packageSha256: PACKAGE } }
}

function composerInput(capture: AttemptTaskPatchCaptureV2, flowId: FlowId, attemptId: AttemptId) {
  const base = { kind: 'TASK' as const, taskChangeSetId: 'xhbcs_main_accept_v2' as TaskChangeSetId, version: 1 as const, flowId,
    planRevisionId: 'xhbpr_main_accept_v2' as PlanRevisionId, taskRunId: 'xhbr_main_accept_v2' as TaskRunId, attemptId,
    verificationAttemptId: 'xhbva_main_accept_v2' as VerificationAttemptId, candidateId: 'xhcand_main_accept_v2' as TaskChangeSetCandidateId,
    inputTreeHash: capture.inputTreeHash as Sha256Digest, resultTreeHash: capture.resultTreeHash as Sha256Digest,
    ancestorTaskChangeSetIds: [] as readonly TaskChangeSetId[], patchArtifactId: capture.patchArtifactId as ArtifactId,
    evidenceBundleId: 'xhbev_main_accept_v2' as EvidenceBundleId, qaResultId: 'xhbqa_main_accept_v2' as QaResultId,
    qaConfigVersion: 'synthetic.v2', createdAt: NOW as IsoDateTime }
  const changeSet: TaskChangeSetV1 = { ...base, digest: taskChangeSetDigestV1(base) }
  return { changeSet, patchArtifact: { artifactId: base.patchArtifactId, digest: capture.patchArtifactDigest as Sha256Digest, bytes: capture.patchArtifactBytes } }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function digest(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
}
