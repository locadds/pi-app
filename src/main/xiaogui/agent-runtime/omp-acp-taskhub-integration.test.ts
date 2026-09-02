import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AttemptId,
  FlowId,
  HubAddressV1,
  HubSystemCommandRequestM2BV1,
  SessionCollaborationProjectionM2BV1,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type {
  AgentRuntimeHostV1,
} from './runtime-host'
import type {
  RuntimeContractTestCreateOrResumeRequestV1,
  RuntimeTestAdapterSelectionV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

import type { CollaborationHubApplicationV1 } from '../task-hub/application'
import {
  XiaoguiTaskExecutionOrchestratorV1,
  type TaskExecutionPermissionPortV1,
} from '../task-hub/execution-orchestrator'
import { createRuntimeOutcomeMonitorV1 } from '../task-hub/runtime-outcome-monitor'
import type { TaskVerificationCoordinatorV1 } from '../task-hub/task-verification-coordinator'
import type {
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
  AcpSessionUpdateParamsV1,
  AcpTransportCreateOptionsV1,
  AcpTransportFactoryV1,
  AcpTransportStartOptionsV1,
  AcpTransportV1,
} from './acp/types'
import { digestBytes } from './acp/workspace-policy'
import {
  createOmpAcpRuntimeAdapterV1,
  OMP_ACP_ADAPTER_ID_V1,
  OMP_ACP_APPROVED_VERSION_V1,
  ompAcpCapabilityDigestForVersionV1,
} from './omp-acp-adapter'
import { createAgentRuntimeContractTestHostV1 } from './runtime-host'

const ADDRESS = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
} as HubAddressV1
const FLOW_ID = 'xhbf_omp_permission' as FlowId
const TASK_RUN_ID = 'xhbtr_omp_permission' as TaskRunId
const ATTEMPT_ID = 'xhba_omp_permission' as AttemptId
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Oh My Pi ACP to TaskHub permission seam', () => {
  it('routes a real OMP write request through RuntimeMonitor and the TaskHub manifest gate', async () => {
    const root = tempRoot()
    const filePath = join(root, 'a.txt')
    writeFileSync(filePath, 'before', 'utf8')
    let vendorPermission: AcpRequestPermissionResultV1 | undefined
    const factory = new PermissionTransportFactory(async (transport) => {
      vendorPermission = await transport.requestPermission({
        sessionId: 'omp-vendor-session-taskhub',
        toolCall: {
          toolCallId: 'omp-write-1',
          kind: 'edit',
          title: 'Edit file',
          locations: [{ path: filePath, line: 1 }],
        },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'allow-always', kind: 'allow_always' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      })
      transport.sessionUpdate({
        sessionId: 'omp-vendor-session-taskhub',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'write approved through TaskHub' },
        },
      })
    })
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: {
        async resolve() {
          return {
            rootPath: root,
            allowedFiles: [{
              relativePath: 'a.txt',
              contentDigest: digestBytes(Buffer.from(readFileSync(filePath))),
            }],
          }
        },
      },
      runtimeStateDir: join(root, 'omp-state'),
      probe: {
        async findExecutable() {
          return {
            available: true as const,
            command: 'omp',
            args: ['--approval-mode', 'always-ask', '--no-skills', '--no-rules', 'acp'],
            version: OMP_ACP_APPROVED_VERSION_V1,
          }
        },
      },
      transportFactory: factory,
    })
    const runtime = createAgentRuntimeContractTestHostV1(adapter)
    const created = await runtime.createOrResume(contractRequest(root))
    expect(created).toMatchObject({ state: 'READY' })
    if (!('runtimeSessionId' in created)) throw new Error('runtime session missing')

    const dbPath = join(root, 'task-hub.sqlite')
    const application = fakeApplication(dbPath, created.runtimeSessionId)
    const monitor = createRuntimeOutcomeMonitorV1({
      runtime: runtime as unknown as AgentRuntimeHostV1,
      intervalMs: 0,
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 0)),
    })
    const permissionIntents: Parameters<TaskExecutionPermissionPortV1['decide']>[0][] = []
    let resolveVerified!: () => void
    const verified = new Promise<void>((resolve) => { resolveVerified = resolve })
    const verificationCoordinator: TaskVerificationCoordinatorV1 = {
      async handleSucceeded() {
        resolveVerified()
        return { ok: true, verificationAttemptId: 'xhbva_omp_permission' as never, verdict: 'PASS' }
      },
      async recoverPending() { return [] },
      async close() {},
    }
    const orchestrator = new XiaoguiTaskExecutionOrchestratorV1({
      dbPath,
      application,
      inputStage: { stageAttemptInput: vi.fn(() => ({})) },
      fileScopeResolver: {
        async resolveApprovedFiles(_projectId, selections) {
          return selections.map((selection) => selection.operation === 'MODIFY'
            ? { ...selection, baselineDigest: 'sha256:baseline' }
            : selection)
        },
      },
      runtimeMonitor: monitor,
      verificationCoordinator,
      permissionModule: {
        decide: vi.fn(async (intent) => {
          permissionIntents.push(intent)
          return 'ALLOW_ONCE' as const
        }),
      },
      permissionScope: {
        manifest: () => ({
          attemptId: ATTEMPT_ID,
          version: 1,
          grants: [{ operation: 'MODIFY', relativePath: 'a.txt', baselineDigest: 'sha256:baseline' }],
          manifestDigest: 'sha256:manifest',
        }),
      },
      now: () => '2026-09-02T00:00:00.000Z',
      idFactory: (prefix) => `${prefix}_omp_permission`,
    })

    try {
      await expect(orchestrator.start({
        address: ADDRESS,
        flowId: FLOW_ID,
        prompt: '修改 a.txt',
        files: [{ operation: 'MODIFY', relativePath: 'a.txt' }],
      })).resolves.toMatchObject({ ok: true })
      await withTimeout(verified, 5_000)

      expect(permissionIntents).toEqual([expect.objectContaining({
        attemptId: ATTEMPT_ID,
        operation: 'WRITE',
        relativePaths: ['a.txt'],
        dataEgress: 'NONE',
      })])
      expect(permissionIntents[0]).not.toHaveProperty('actionDigest')
      expect(vendorPermission).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    } finally {
      await orchestrator.close()
      await adapter.close()
    }
  })
})

function contractRequest(rootPath: string): RuntimeContractTestCreateOrResumeRequestV1 {
  const prompt = Buffer.from('edit a.txt', 'utf8')
  const selection = {
    adapterId: OMP_ACP_ADAPTER_ID_V1,
    runtimeKind: 'OTHER',
    protocol: 'ACP',
    capabilityDigest: ompAcpCapabilityDigestForVersionV1(OMP_ACP_APPROVED_VERSION_V1),
    approvalStatus: 'APPROVED_FOR_TEST',
    diagnosticOnly: false,
    stream: 'POLL',
    interrupt: 'BEST_EFFORT',
    inspect: 'SNAPSHOT',
  } satisfies RuntimeTestAdapterSelectionV1
  return {
    executionMode: 'CONTRACT_TEST',
    requestId: 'omp-taskhub-request-1',
    scope: {
      projectId: ADDRESS.projectId,
      sessionKey: ADDRESS.sessionKey,
      sessionMode: 'CODING',
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'workspace-receipt-1',
      workspaceReceiptDigest: 'sha256:workspace-receipt',
    },
    workspace: {
      attemptWorktreeId: 'worktree-omp-permission',
      worktreeRootDigest: digestBytes(Buffer.from(rootPath)),
      baseRevisionDigest: 'sha256:base',
      targetProjectRootDigest: 'sha256:target',
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    },
    selection,
    contractTestPolicy: {
      rejectDiagnosticOnly: true,
      workspacePolicy: 'ATTEMPT_WORKTREE_ONLY',
      productEnablement: false,
      allowedSelections: [selection],
    },
    promptEnvelopeRef: {
      refId: 'prompt-omp-taskhub',
      digest: digestBytes(prompt),
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
  }
}

function payloadResolver(): TrustedRuntimePayloadResolverV1 {
  return {
    async resolvePrompt(ref) {
      return {
        promptEnvelopeRef: ref,
        redactedPreviewDigest: 'sha256:redacted',
        payloadBytes: Buffer.from('edit a.txt', 'utf8'),
      }
    },
    async resolveMessage(ref) {
      return {
        messageEnvelopeRef: ref,
        redactedPreviewDigest: 'sha256:redacted-message',
        payloadBytes: Buffer.from('continue', 'utf8'),
      }
    },
    async *resolveTextStream() {},
    async resolveCandidateFile(ref) {
      return {
        candidateFileRef: ref,
        relativePathDigest: 'sha256:path',
        contentDigest: 'sha256:content',
        payloadBytes: new Uint8Array(),
      }
    },
    async toM2ChangeSetCandidate(input) {
      return { changeSetCandidateId: 'unused', digest: input.candidateDigest }
    },
  }
}

function fakeApplication(dbPath: string, runtimeSessionId: string): CollaborationHubApplicationV1 {
  let attemptStatus: 'WORKSPACE_PREPARING' | 'READY' | 'RUNNING' | undefined
  const projection = (): SessionCollaborationProjectionM2BV1 => ({
    kind: 'SESSION_COLLABORATION_PROJECTION',
    version: 'm2b.v1',
    address: ADDRESS,
    sessionVersion: attemptStatus ? 2 : 1,
    sessionMode: 'CODING',
    authoritativeMode: 'CODING',
    reserved: false,
    activeFlow: { flowId: FLOW_ID, status: 'PLAN_ACTIVE', activeRevisionId: null, objective: 'OMP 权限接缝' },
    activeRevision: null,
    taskSpecs: [{
      taskSpecId: 'xhbts_omp_permission' as never,
      taskKey: 'omp-permission',
      title: '验证 OMP 写权限',
      dependsOn: [],
      unavailableReason: 'AGENT_DISABLED_M2A',
    }],
    taskRuns: [{
      taskRunId: TASK_RUN_ID,
      taskSpecId: 'xhbts_omp_permission' as never,
      taskKey: 'omp-permission',
      status: attemptStatus ? 'RUNNING' : 'BLOCKED',
      ...(attemptStatus ? { attemptId: ATTEMPT_ID } : {}),
    }],
    attempts: attemptStatus ? [{
      attemptId: ATTEMPT_ID,
      taskRunId: TASK_RUN_ID,
      status: attemptStatus,
      workspaceReceiptId: 'workspace-receipt-1' as never,
    }] : [],
    history: [],
    availableActions: attemptStatus ? ['flow.cancel'] : ['flow.cancel', 'execution.next.confirm'],
  })
  return {
    observeM2B: vi.fn(async () => ({ ok: true as const, value: projection() })),
    executeSystem: vi.fn(async (command: HubSystemCommandRequestM2BV1) => {
      if (command.intent.type === 'system.schedule') {
        attemptStatus = 'WORKSPACE_PREPARING'
        return systemSuccess(command, 2)
      }
      if (command.intent.type === 'system.agent.report.record') {
        attemptStatus = 'RUNNING'
        writePrivateRuntimeAttempt(dbPath, runtimeSessionId)
        return systemSuccess(command, 4)
      }
      throw new Error(`unexpected ${command.intent.type}`)
    }),
    prepareNextWorkspace: vi.fn(async (_address, request) => {
      attemptStatus = 'READY'
      return {
        ok: true as const,
        value: {
          requestId: request.requestId,
          intentType: 'system.workspace.prepare.result.record' as const,
          sessionVersion: 3,
          flowId: FLOW_ID,
          taskRunId: TASK_RUN_ID,
          attemptId: ATTEMPT_ID,
        },
      }
    }),
  } as unknown as CollaborationHubApplicationV1
}

function systemSuccess(command: HubSystemCommandRequestM2BV1, sessionVersion: number) {
  return {
    ok: true as const,
    value: {
      requestId: command.requestId,
      intentType: command.intent.type,
      sessionVersion,
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
    },
  }
}

function writePrivateRuntimeAttempt(dbPath: string, runtimeSessionId: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma foreign_keys = off')
    db.prepare(`
      insert or replace into attempts (
        attempt_id, project_id, session_key, flow_id, task_run_id, status,
        attempt_digest, workspace_receipt_id, runtime_session_id,
        outcome_receipt_digest, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, null, ?, ?)
    `).run(
      ATTEMPT_ID,
      ADDRESS.projectId,
      ADDRESS.sessionKey,
      FLOW_ID,
      TASK_RUN_ID,
      'sha256:attempt',
      'workspace-receipt-1',
      runtimeSessionId,
      '2026-09-02T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    )
  } finally {
    db.close()
  }
}

class PermissionTransport implements AcpTransportV1 {
  private options?: AcpTransportStartOptionsV1

  constructor(private readonly script: (transport: PermissionTransport) => Promise<void>) {}

  async start(options: AcpTransportStartOptionsV1) {
    this.options = options
    return {
      protocolVersion: 1,
      agentInfo: { name: 'oh-my-pi', version: OMP_ACP_APPROVED_VERSION_V1 },
      agentCapabilities: { loadSession: true },
    }
  }

  async newSession() { return { sessionId: 'omp-vendor-session-taskhub' } }
  async loadSession() {}
  async prompt() {
    await this.script(this)
    return { stopReason: 'end_turn' }
  }
  async cancel() {}
  async dispose() {}

  requestPermission(params: AcpRequestPermissionParamsV1) {
    if (!this.options) throw new Error('transport not started')
    return this.options.onPermissionRequest(params)
  }

  sessionUpdate(params: AcpSessionUpdateParamsV1) {
    this.options?.onSessionUpdate(params)
  }
}

class PermissionTransportFactory implements AcpTransportFactoryV1 {
  constructor(private readonly script: (transport: PermissionTransport) => Promise<void>) {}

  create(_command: string, _args: readonly string[], _cwd: string, _options?: AcpTransportCreateOptionsV1) {
    return new PermissionTransport(this.script)
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-omp-taskhub-'))
  roots.push(root)
  return root
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('OMP_TASKHUB_INTEGRATION_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
