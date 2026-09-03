import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  RuntimeCreateOrResumeRequestV1,
  RuntimeOutcomeV1,
  RuntimeProductionPolicyV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'
import type {
  AttemptId,
  FlowId,
  PlanRevisionId,
  TaskRunId,
} from '@shared/xiaogui-collaboration-hub'
import type {
  DeliveryBatchId,
  DeliveryChangeSetId,
  DeliverySelectionDraftId,
} from '@shared/xiaogui-delivery'
import {
  taskChangeSetDigestV1,
  type EvidenceBundleId,
  type IsoDateTime,
  type QaResultId,
  type Sha256Digest,
  type TaskChangeSetCandidateId,
  type TaskChangeSetId,
  type TaskChangeSetV1,
  type VerificationAttemptId,
} from '@shared/xiaogui-task-verification'

import {
  GitAttemptWorkspaceServiceV1,
  SqliteAttemptWorkspaceRegistryV1,
  digestBytes,
} from '../task-hub/attempt-workspace'
import { DeliveryComposerV1 } from '../task-hub/delivery-composer'
import { createRuntimeOutcomeMonitorV1 } from '../task-hub/runtime-outcome-monitor'
import { TaskCandidateAuditServiceV1 } from '../task-hub/task-candidate-audit'
import type {
  AcpElicitationCreateParamsV1,
  AcpElicitationCreateResultV1,
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
  AcpSessionUpdateParamsV1,
  AcpTransportCreateOptionsV1,
  AcpTransportFactoryV1,
  AcpTransportStartOptionsV1,
  AcpTransportV1,
} from './acp/types'
import { AcpProcessTransportFactoryV1 } from './acp/process-transport'
import { KimiAttemptWorkspaceResolverV1 } from './kimi-attempt-workspace'
import {
  createOmpAcpRuntimeAdapterV1,
  OMP_ACP_APPROVED_VERSION_V1,
  OMP_ACP_SAFE_ARGS_V1,
  ompAcpProductionSelectionV1,
  type OmpAcpTrustedLaunchPortV1,
} from './omp-acp-adapter'
import {
  OmpTrustedAcpLaunchProviderV1,
  SqliteOmpAcpRecoveryStoreV1,
  TaskHubOmpCandidateInspectorV1,
} from './omp-acp-production'
import {
  OmpTrustedInstallationModuleV1,
} from './omp-trusted-installation'
import type { OmpRuntimeBundleActivationReceiptV1 } from './omp-runtime-bundle'
import { createAgentRuntimeRegistryV1 } from './runtime-registry'

const roots: string[] = []
const PROJECT_ID = 'xgp_omp_p1c'
const ATTEMPT_ID = 'xhba_omp_p1c' as AttemptId
const FLOW_ID = 'xhbf_omp_p1c' as FlowId
const TASK_RUN_ID = 'xhbtr_omp_p1c' as TaskRunId
const RECEIPT_DIGEST = `sha256:${'a'.repeat(64)}`
const VENDOR_SESSION_ID = 'omp-vendor-session-p1c'
const SETTLED_AT = '2026-09-03T08:00:00.000Z'
const closers: Array<() => void | Promise<void>> = []
const realOmpP1cIt = process.env.XIAOGUI_OMP_P1C_REAL_SMOKE === '1' ? it : it.skip

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try {
      await close()
    } catch {
      // A failed assertion can leave a SQLite handle open; best-effort close
      // keeps the temporary evidence directory recoverable on Windows.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

describe('Oh My Pi ACP P1C production seam', () => {
  it('derives a production launch only from a verified package receipt and exact entry', async () => {
    const runtimeRoot = tempRoot('xiaogui-omp-launch-')
    const root = join(runtimeRoot, 'node_modules', '@oh-my-pi', 'pi-coding-agent')
    const entry = join(root, 'dist', 'cli.js')
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(entry, `console.log('${OMP_ACP_APPROVED_VERSION_V1}')\n`, 'utf8')
    const inspect = vi.fn(async () => ({
      ok: true as const,
      packageRoot: root,
      runtimeRoot,
      receipt: {
        entryRelativePath: 'dist/cli.js',
        receiptDigest: RECEIPT_DIGEST,
      } as OmpRuntimeBundleActivationReceiptV1,
    }))
    const provider = new OmpTrustedAcpLaunchProviderV1({
      installation: { inspect },
      bunProbe: {
        async findExecutable() {
          return { available: true as const, command: process.execPath, version: '1.3.14' }
        },
      },
    })

    await expect(provider.inspectLaunch()).resolves.toEqual({
      available: true,
      command: process.execPath,
      args: [entry, ...OMP_ACP_SAFE_ARGS_V1],
      version: OMP_ACP_APPROVED_VERSION_V1,
      installationReceiptDigest: RECEIPT_DIGEST,
    })
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('does not let a same-version PATH executable bypass a missing trusted receipt', async () => {
    const root = tempRoot('xiaogui-omp-untrusted-')
    const selection = ompAcpProductionSelectionV1()
    const probe = { findExecutable: vi.fn(async () => ({
      available: true as const,
      command: 'omp',
      args: OMP_ACP_SAFE_ARGS_V1,
      version: OMP_ACP_APPROVED_VERSION_V1,
    })) }
    const resolveWorkspace = vi.fn()
    const createTransport = vi.fn()
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver('change the file'),
      workspaceResolver: { resolve: resolveWorkspace },
      runtimeStateDir: join(root, 'state'),
      probe,
      transportFactory: { create: createTransport } as unknown as AcpTransportFactoryV1,
      productionGate: {
        enabled: true,
        selection,
        trustedLaunch: {
          async inspectLaunch() {
            return { available: false as const, reasonCode: 'OMP_INSTALLATION_RECEIPT_INVALID' }
          },
        },
        recoveryStore: inertRecoveryStore(),
        candidateInspector: { async inspect() { throw new Error('must not inspect') } },
      },
    })

    await expect(adapter.createOrResume(syntheticRequest(root))).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'OMP_INSTALLATION_RECEIPT_INVALID',
    })
    expect(probe.findExecutable).not.toHaveBeenCalled()
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(createTransport).not.toHaveBeenCalled()
    await adapter.close()
  })

  it('replays settled and unsettled requests from durable recovery before inspecting a transiently unavailable install', async () => {
    const root = tempRoot('xiaogui-omp-replay-')
    const recovery = new SqliteOmpAcpRecoveryStoreV1({
      dbPath: join(root, 'recovery.sqlite'),
      now: () => SETTLED_AT,
    })
    const settledRequest = {
      ...syntheticRequest(root),
      requestId: 'xhbrr_omp_p1d_settled',
    }
    const unsettledRequest = {
      ...syntheticRequest(root),
      requestId: 'xhbrr_omp_p1d_unsettled',
    }
    const settledSessionId = `xgrs_${'c'.repeat(32)}`
    const unsettledSessionId = `xgrs_${'d'.repeat(32)}`
    await recovery.bind({
      publicRuntimeSessionId: settledSessionId,
      vendorSessionId: 'omp-vendor-session-p1d-settled',
      request: settledRequest,
      installationReceiptDigest: RECEIPT_DIGEST,
    })
    const settledOutcome = {
      state: 'SUCCEEDED' as const,
      runtimeSessionId: settledSessionId,
      receiptDigest: `sha256:${'8'.repeat(64)}`,
      candidateDigest: `sha256:${'7'.repeat(64)}`,
    }
    await recovery.settle(settledSessionId, settledOutcome)
    await recovery.bind({
      publicRuntimeSessionId: unsettledSessionId,
      vendorSessionId: 'omp-vendor-session-p1d-unsettled',
      request: unsettledRequest,
      installationReceiptDigest: RECEIPT_DIGEST,
    })

    const inspectLaunch = vi.fn(async () => ({
      available: false as const,
      reasonCode: 'OMP_RUNTIME_BUNDLE_NOT_ACTIVATED',
    }))
    const resolveWorkspace = vi.fn()
    const createTransport = vi.fn()
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver('must not resolve'),
      workspaceResolver: { resolve: resolveWorkspace },
      runtimeStateDir: join(root, 'state'),
      transportFactory: { create: createTransport } as unknown as AcpTransportFactoryV1,
      productionGate: {
        enabled: true,
        selection: ompAcpProductionSelectionV1(),
        trustedLaunch: { inspectLaunch },
        recoveryStore: recovery,
        candidateInspector: {
          async inspect() { return { candidateDigest: settledOutcome.candidateDigest } },
        },
      },
    })

    await expect(adapter.createOrResume(settledRequest)).resolves.toEqual(settledOutcome)
    await expect(adapter.inspect(settledSessionId)).resolves.toEqual(settledOutcome)
    await expect(adapter.createOrResume(unsettledRequest)).resolves.toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId: unsettledSessionId,
      reasonCode: 'OMP_RESTORED_OUTCOME_UNSETTLED',
    })
    await expect(adapter.inspect(unsettledSessionId)).resolves.toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      runtimeSessionId: unsettledSessionId,
      reasonCode: 'OMP_RESTORED_OUTCOME_UNSETTLED',
    })
    const laterOutcome = {
      state: 'FAILED' as const,
      runtimeSessionId: unsettledSessionId,
      receiptDigest: `sha256:${'6'.repeat(64)}`,
      reasonCode: 'OMP_TEST_LATER_SETTLED',
    }
    await recovery.settle(unsettledSessionId, laterOutcome)
    await expect(adapter.createOrResume(unsettledRequest)).resolves.toEqual(laterOutcome)
    expect(inspectLaunch).not.toHaveBeenCalled()
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(createTransport).not.toHaveBeenCalled()
    await adapter.close()
  })

  it('adds the request lookup seam to an existing P1C recovery database', async () => {
    const root = tempRoot('xiaogui-omp-recovery-migration-')
    const dbPath = join(root, 'recovery.sqlite')
    const request = { ...syntheticRequest(root), requestId: 'xhbrr_omp_p1d_migrated' }
    const publicRuntimeSessionId = `xgrs_${'e'.repeat(32)}`
    const vendorSessionId = 'omp-vendor-session-p1d-migrated'
    const requestDigest = testDigestJson(request)
    const selectionDigest = testDigestJson(request.selection)
    const workspaceBindingDigest = testDigestJson(request.workspace)
    const unsignedBinding = {
      publicRuntimeSessionId,
      vendorSessionId,
      attemptId: request.scope.attemptId,
      requestDigest,
      selectionDigest,
      workspaceBindingDigest,
      installationReceiptDigest: RECEIPT_DIGEST,
      createdAt: SETTLED_AT,
    }
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      create table xiaogui_omp_acp_recovery_bindings_v1 (
        public_runtime_session_id text primary key,
        vendor_session_id text not null,
        attempt_id text not null,
        request_json text not null,
        request_digest text not null,
        selection_digest text not null,
        workspace_binding_digest text not null,
        installation_receipt_digest text not null,
        binding_digest text not null,
        outcome_json text,
        outcome_digest text,
        created_at text not null,
        settled_at text
      )
    `)
    legacy.prepare(`
      insert into xiaogui_omp_acp_recovery_bindings_v1 (
        public_runtime_session_id, vendor_session_id, attempt_id, request_json,
        request_digest, selection_digest, workspace_binding_digest,
        installation_receipt_digest, binding_digest, outcome_json,
        outcome_digest, created_at, settled_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, null)
    `).run(
      publicRuntimeSessionId,
      vendorSessionId,
      request.scope.attemptId,
      JSON.stringify(request),
      requestDigest,
      selectionDigest,
      workspaceBindingDigest,
      RECEIPT_DIGEST,
      testDigestJson({ domain: 'xiaogui.omp-acp.recovery-binding.v1', ...unsignedBinding }),
      SETTLED_AT,
    )
    legacy.close()

    const recovery = new SqliteOmpAcpRecoveryStoreV1({ dbPath, now: () => SETTLED_AT })
    await expect(recovery.readByRequestId(request.requestId)).resolves.toMatchObject({
      publicRuntimeSessionId,
      vendorSessionId,
      request,
    })
    await expect(recovery.bind({
      publicRuntimeSessionId: `xgrs_${'f'.repeat(32)}`,
      vendorSessionId: 'omp-vendor-session-p1d-duplicate',
      request,
      installationReceiptDigest: RECEIPT_DIGEST,
    })).rejects.toThrow('OMP_RECOVERY_REQUEST_CONFLICT')
    recovery.close()
  })

  it('keeps RuntimeMonitor, real worktree Diff, TaskChangeSet, Delivery, and restart recovery on one candidate digest', async () => {
    const root = tempRoot('xiaogui-omp-p1c-')
    const projectRoot = createGitProject(join(root, 'project'))
    const workspaceDb = join(root, 'workspace.sqlite')
    const managedRoot = join(root, 'attempt-worktrees')
    const projectResolver = { resolveProjectRoot: () => projectRoot }
    let workspaceRegistry = trackClose(new SqliteAttemptWorkspaceRegistryV1({ dbPath: workspaceDb }))
    let workspaces = new GitAttemptWorkspaceServiceV1(workspaceRegistry, projectResolver, { managedRoot })
    const baseRevision = git(projectRoot, ['rev-parse', 'HEAD'])
    const baselineTreeHash = git(projectRoot, ['rev-parse', `${baseRevision}^{tree}`])
    const prepared = await workspaces.prepare({
      attemptId: ATTEMPT_ID,
      compositionAttemptId: 'xhbc_omp_p1c',
      requestDigest: `sha256:${'1'.repeat(64)}`,
      baselineBindingDigest: `sha256:${'2'.repeat(64)}`,
      compositionDigest: `sha256:${'3'.repeat(64)}`,
      projectId: PROJECT_ID,
      baseRevision,
      baselineTreeHash,
      manifest: {
        attemptId: ATTEMPT_ID,
        version: 1,
        grants: [{
          operation: 'MODIFY',
          relativePath: 'src/feature.ts',
          baselineDigest: digestBytes('export const value = 1'),
        }],
      },
      ownerId: 'xiaogui-omp-p1c-test',
    })
    const request = productionRequest(prepared.workspace)
    const recoveryDb = join(root, 'omp-recovery.sqlite')
    const firstRecovery = trackClose(new SqliteOmpAcpRecoveryStoreV1({
      dbPath: recoveryDb,
      now: () => SETTLED_AT,
    }))
    const firstFactory = new JourneyTransportFactory(async (transport) => {
      await expect(transport.requestElicitation({
        mode: 'form',
        sessionId: VENDOR_SESSION_ID,
        message: 'Allow tool: edit\nFile: src/feature.ts\nunexpected envelope line',
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'string', enum: ['Approve', 'Deny'] } },
          required: ['value'],
        },
      })).resolves.toEqual({ action: 'cancel' })
      await expect(transport.requestElicitation({
        mode: 'form',
        sessionId: VENDOR_SESSION_ID,
        message: 'Allow tool: edit\nFile: src/feature.ts[…200ch elided…]',
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'string', enum: ['Approve', 'Deny'] } },
          required: ['value'],
        },
      })).resolves.toEqual({ action: 'cancel' })
      const decision = await transport.requestElicitation({
        mode: 'form',
        sessionId: VENDOR_SESSION_ID,
        message: 'Allow tool: edit\nFile: src/feature.ts',
        requestedSchema: {
          type: 'object',
          properties: { value: { type: 'string', enum: ['Approve', 'Deny'] } },
          required: ['value'],
        },
      })
      if (decision.action === 'accept' && decision.content.value === 'Approve') {
        writeFileSync(join(prepared.handle.rootPath, 'src', 'feature.ts'), 'export const value = 2', 'utf8')
      }
      transport.sessionUpdate({
        sessionId: VENDOR_SESSION_ID,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'omp-write-p1c',
          kind: 'edit',
          title: 'Edit feature',
          locations: [{ path: join(prepared.handle.rootPath, 'src', 'feature.ts'), line: 1 }],
          status: 'completed',
        },
      })
      transport.sessionUpdate({
        sessionId: VENDOR_SESSION_ID,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'updated the approved file' },
        },
      })
    })
    const firstAdapter = createProductionAdapter({
      root,
      workspaces,
      recovery: firstRecovery,
      factory: firstFactory,
    })
    const firstRuntime = trackClose(createAgentRuntimeRegistryV1())
    await firstRuntime.register(firstAdapter)
    const created = await firstRuntime.createOrResume(request)
    expect(created).toMatchObject({ state: 'READY' })
    if (!('runtimeSessionId' in created)) throw new Error('runtime session missing')

    const monitor = createRuntimeOutcomeMonitorV1({
      runtime: firstRuntime,
      intervalMs: 0,
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 0)),
    })
    const monitored = new Promise<RuntimeOutcomeV1>((resolve) => {
      monitor.watch(created.runtimeSessionId, resolve, (event) => ({
        type: 'ALLOW_ONCE',
        permissionRequestId: event.permissionRequestId,
        challengeDigest: event.challengeDigest,
        decisionRequestId: 'xhbpd_omp_p1c',
        scope: event.scope,
        runtimeSessionId: created.runtimeSessionId,
        proofId: 'xhbpp_omp_p1c',
        proofDigest: `sha256:${'4'.repeat(64)}`,
      }))
    })
    const outcome = await withTimeout(monitored, 5_000)
    await monitor.close()
    expect(outcome).toMatchObject({
      state: 'SUCCEEDED',
      runtimeSessionId: created.runtimeSessionId,
      candidateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    if (outcome.state !== 'SUCCEEDED') throw new Error('production outcome missing')
    expect(firstFactory.transports[0]?.promptCalls).toBe(1)
    expect(firstFactory.transports[0]?.configCalls).toEqual([{
      sessionId: VENDOR_SESSION_ID,
      configId: 'model',
      value: 'kimi-coding/k3-256k',
    }])
    expect(readFileSync(join(prepared.handle.rootPath, 'src', 'feature.ts'), 'utf8')).toBe('export const value = 2')
    expect(readFileSync(join(projectRoot, 'src', 'feature.ts'), 'utf8')).toBe('export const value = 1')

    const hostCapture = await workspaces.captureTaskPatch(ATTEMPT_ID)
    expect(hostCapture.resultTreeHash).toBe(outcome.candidateDigest)
    const audit = await new TaskCandidateAuditServiceV1(workspaces, {
      verify: (input) => firstRecovery.verifyCandidateBinding(input),
    }).captureTaskCandidate({
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      createdAt: SETTLED_AT,
      runtimeSignal: {
        runtimeSessionId: outcome.runtimeSessionId,
        receiptDigest: outcome.receiptDigest,
        candidateDigest: outcome.candidateDigest,
      },
    })
    expect(audit.candidate.resultTreeHash).toBe(outcome.candidateDigest)

    const taskChangeSet = sealedTaskChangeSet(audit)
    expect(taskChangeSet.resultTreeHash).toBe(outcome.candidateDigest)
    const composer = new DeliveryComposerV1({
      async integrate(files) {
        expect(files).toHaveLength(1)
        expect(Buffer.from(files[0]!.content).toString('utf8')).toBe('export const value = 2')
        return {
          integrationTreeHash: `sha256:${'5'.repeat(64)}` as Sha256Digest,
          privateIntegrationContext: {
            worktreeRoot: join(root, 'delivery-worktree'),
            trustedToolchainRoot: projectRoot,
          },
        }
      },
    })
    const delivery = await composer.compose({
      flowId: FLOW_ID,
      deliveryBatchId: 'xhbd_omp_p1c' as DeliveryBatchId,
      selectionDraftId: 'xhbds_omp_p1c' as DeliverySelectionDraftId,
      deliveryChangeSetId: 'xhbdcs_omp_p1c' as DeliveryChangeSetId,
      taskInputs: [{
        changeSet: taskChangeSet,
        patchArtifact: {
          artifactId: audit.patchArtifact.artifactId,
          digest: audit.patchArtifact.digest,
          bytes: audit.patchArtifact.bytes,
        },
      }],
      dependencyOrder: [taskChangeSet.taskChangeSetId],
      selectionDigest: `sha256:${'6'.repeat(64)}` as Sha256Digest,
      target: {
        projectId: PROJECT_ID,
        baseRevision,
        baselineTreeHash,
        initialTargetFingerprint: `sha256:${'7'.repeat(64)}` as Sha256Digest,
      },
      qaConfigVersion: 'xiaogui.coding.delivery.v1',
      createdAt: SETTLED_AT as IsoDateTime,
    })
    expect(delivery).toMatchObject({
      ok: true,
      changeSet: {
        taskChangeSets: [{ digest: taskChangeSet.digest }],
      },
    })
    const tampered = await composer.compose({
      flowId: FLOW_ID,
      deliveryBatchId: 'xhbd_omp_p1c' as DeliveryBatchId,
      selectionDraftId: 'xhbds_omp_p1c' as DeliverySelectionDraftId,
      deliveryChangeSetId: 'xhbdcs_omp_p1c' as DeliveryChangeSetId,
      taskInputs: [{
        changeSet: { ...taskChangeSet, resultTreeHash: `sha256:${'8'.repeat(64)}` as Sha256Digest },
        patchArtifact: {
          artifactId: audit.patchArtifact.artifactId,
          digest: audit.patchArtifact.digest,
          bytes: audit.patchArtifact.bytes,
        },
      }],
      dependencyOrder: [taskChangeSet.taskChangeSetId],
      selectionDigest: `sha256:${'6'.repeat(64)}` as Sha256Digest,
      target: {
        projectId: PROJECT_ID,
        baseRevision,
        baselineTreeHash,
        initialTargetFingerprint: `sha256:${'7'.repeat(64)}` as Sha256Digest,
      },
      qaConfigVersion: 'xiaogui.coding.delivery.v1',
      createdAt: SETTLED_AT as IsoDateTime,
    })
    expect(tampered).toMatchObject({ ok: false, reasonCode: 'TASK_CHANGESET_DIGEST_DRIFT' })

    const unsettledRuntimeSessionId = `xgrs_${'b'.repeat(32)}`
    const unsettledRequest = {
      ...request,
      requestId: 'xhbrr_omp_p1c_unsettled_recovery',
    }
    await firstRecovery.bind({
      publicRuntimeSessionId: unsettledRuntimeSessionId,
      vendorSessionId: 'omp-vendor-session-unsettled',
      request: unsettledRequest,
      installationReceiptDigest: RECEIPT_DIGEST,
    })
    const stored = await firstRecovery.read(created.runtimeSessionId)
    expect(stored).toMatchObject({
      request: {
        scope: { attemptId: ATTEMPT_ID },
        selection: ompAcpProductionSelectionV1(),
        workspace: prepared.workspace,
      },
      vendorSessionId: VENDOR_SESSION_ID,
      outcome: { candidateDigest: outcome.candidateDigest },
    })
    expect(JSON.stringify(stored)).not.toContain(prepared.handle.rootPath)
    await firstRuntime.close()
    workspaceRegistry.close()

    workspaceRegistry = trackClose(new SqliteAttemptWorkspaceRegistryV1({ dbPath: workspaceDb }))
    workspaces = new GitAttemptWorkspaceServiceV1(workspaceRegistry, projectResolver, { managedRoot })
    const driftRecovery = trackClose(new SqliteOmpAcpRecoveryStoreV1({ dbPath: recoveryDb }))
    const driftFactory = new JourneyTransportFactory()
    const driftRuntime = trackClose(createAgentRuntimeRegistryV1())
    await driftRuntime.register(createProductionAdapter({
      root,
      workspaces,
      recovery: driftRecovery,
      factory: driftFactory,
      receiptDigest: `sha256:${'c'.repeat(64)}`,
    }))
    await expect(driftRuntime.restoreBinding(created.runtimeSessionId, ompAcpProductionSelectionV1())).resolves.toEqual({
      ok: false,
      reasonCode: 'RUNTIME_SESSION_RESTORE_UNAVAILABLE',
    })
    expect(driftFactory.transports).toHaveLength(0)
    await driftRuntime.close()

    const recoveredStore = trackClose(new SqliteOmpAcpRecoveryStoreV1({ dbPath: recoveryDb }))
    const recoveredFactory = new JourneyTransportFactory()
    const recoveredRuntime = trackClose(createAgentRuntimeRegistryV1())
    await recoveredRuntime.register(createProductionAdapter({
      root,
      workspaces,
      recovery: recoveredStore,
      factory: recoveredFactory,
    }))
    await expect(recoveredRuntime.restoreBinding(created.runtimeSessionId, ompAcpProductionSelectionV1())).resolves.toEqual({ ok: true })
    await expect(recoveredRuntime.inspect(created.runtimeSessionId)).resolves.toEqual(outcome)
    expect(recoveredFactory.transports[0]?.loadCalls).toEqual([{
      sessionId: VENDOR_SESSION_ID,
      cwd: prepared.handle.rootPath,
    }])
    expect(recoveredFactory.transports[0]?.promptCalls).toBe(0)
    expect(recoveredFactory.transports[0]?.configCalls).toEqual([{
      sessionId: VENDOR_SESSION_ID,
      configId: 'model',
      value: 'kimi-coding/k3-256k',
    }])

    await expect(recoveredRuntime.restoreBinding(unsettledRuntimeSessionId, ompAcpProductionSelectionV1())).resolves.toEqual({ ok: true })
    await expect(recoveredRuntime.inspect(unsettledRuntimeSessionId)).resolves.toMatchObject({
      state: 'OUTCOME_UNKNOWN',
      reasonCode: 'OMP_RESTORED_OUTCOME_UNSETTLED',
    })
    expect(recoveredFactory.transports[1]?.loadCalls).toEqual([{
      sessionId: 'omp-vendor-session-unsettled',
      cwd: prepared.handle.rootPath,
    }])
    expect(recoveredFactory.transports[1]?.promptCalls).toBe(0)
    expect(recoveredFactory.transports[1]?.configCalls).toEqual([{
      sessionId: 'omp-vendor-session-unsettled',
      configId: 'model',
      value: 'kimi-coding/k3-256k',
    }])
    await recoveredRuntime.close()
    workspaceRegistry.close()
  }, 20_000)

  realOmpP1cIt('lets the pinned real OMP model modify only its Attempt worktree through ACP', async () => {
    const packageRoot = requiredAbsoluteEnv('XIAOGUI_OMP_P1C_REAL_PACKAGE_ROOT')
    const modelsSource = requiredAbsoluteEnv('XIAOGUI_OMP_P1C_MODELS_JSON')
    const root = tempRoot('xiaogui-omp-p1c-real-')
    const projectRoot = createGitProject(join(root, 'project'))
    const workspaceRegistry = trackClose(new SqliteAttemptWorkspaceRegistryV1({
      dbPath: join(root, 'workspace.sqlite'),
    }))
    const workspaces = new GitAttemptWorkspaceServiceV1(
      workspaceRegistry,
      { resolveProjectRoot: () => projectRoot },
      { managedRoot: join(root, 'attempt-worktrees') },
    )
    const baseRevision = git(projectRoot, ['rev-parse', 'HEAD'])
    const baselineTreeHash = git(projectRoot, ['rev-parse', `${baseRevision}^{tree}`])
    const prepared = await workspaces.prepare({
      attemptId: ATTEMPT_ID,
      compositionAttemptId: 'xhbc_omp_p1c_real',
      requestDigest: `sha256:${'1'.repeat(64)}`,
      baselineBindingDigest: `sha256:${'2'.repeat(64)}`,
      compositionDigest: `sha256:${'3'.repeat(64)}`,
      projectId: PROJECT_ID,
      baseRevision,
      baselineTreeHash,
      manifest: {
        attemptId: ATTEMPT_ID,
        version: 1,
        grants: [{
          operation: 'MODIFY',
          relativePath: 'src/feature.ts',
          baselineDigest: digestBytes('export const value = 1'),
        }],
      },
      ownerId: 'xiaogui-omp-p1c-real-smoke',
    })
    const stateDir = join(root, 'omp-state')
    mkdirSync(stateDir, { recursive: true })
    copyFileSync(modelsSource, join(stateDir, 'models.json'))
    const installation = new OmpTrustedInstallationModuleV1({
      packageRoot,
      privateStateDir: stateDir,
      receiptPath: join(root, 'install', 'receipt-v1.json'),
      now: () => SETTLED_AT,
    })
    installation.recordVerifiedInstallation()
    const recovery = trackClose(new SqliteOmpAcpRecoveryStoreV1({
      dbPath: join(root, 'omp-recovery.sqlite'),
      now: () => SETTLED_AT,
    }))
    const prompt = [
      'Modify only src/feature.ts in the current workspace.',
      'Change the exported numeric value from 1 to 2 using the file editing tool.',
      'Do not run commands and do not change any other file. Stop after the edit succeeds.',
    ].join(' ')
    const processFactory = new TracingProcessTransportFactory()
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(prompt),
      workspaceResolver: new KimiAttemptWorkspaceResolverV1(workspaces, join(root, 'unused-kimi-home')),
      runtimeStateDir: stateDir,
      probe: { async findExecutable() { throw new Error('PATH_PROBE_MUST_NOT_RUN') } },
      transportFactory: processFactory,
      productionGate: {
        enabled: true,
        selection: ompAcpProductionSelectionV1(),
        trustedLaunch: new OmpTrustedAcpLaunchProviderV1({
          installation: {
            async inspect() {
              const inspected = installation.inspect()
              return inspected.ok
                ? {
                    ok: true as const,
                    runtimeRoot: join(packageRoot, '..', '..', '..'),
                    packageRoot,
                    receipt: inspected.receipt as unknown as OmpRuntimeBundleActivationReceiptV1,
                  }
                : inspected
            },
          },
        }),
        recoveryStore: recovery,
        candidateInspector: new TaskHubOmpCandidateInspectorV1(workspaces),
      },
    })
    const runtime = trackClose(createAgentRuntimeRegistryV1())
    await runtime.register(adapter)
    const created = await runtime.createOrResume(productionRequest(prepared.workspace, prompt))
    expect(created).toMatchObject({ state: 'READY' })
    if (!('runtimeSessionId' in created)) throw new Error('runtime session missing')

    const permissionEvidence: Array<{ purpose: string | undefined; paths: readonly string[] }> = []
    let decisionIndex = 0
    const monitor = createRuntimeOutcomeMonitorV1({
      runtime,
      intervalMs: 20,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    })
    const outcome = await withTimeout(new Promise<RuntimeOutcomeV1>((resolve) => {
      monitor.watch(created.runtimeSessionId, resolve, (event) => {
        const paths = event.requestedRelativePaths ?? []
        permissionEvidence.push({ purpose: event.permissionPurpose, paths })
        decisionIndex += 1
        const common = {
          permissionRequestId: event.permissionRequestId,
          challengeDigest: event.challengeDigest,
          decisionRequestId: `xhbpd_omp_p1c_real_${decisionIndex}`,
          scope: event.scope,
          runtimeSessionId: created.runtimeSessionId,
        }
        return paths.length > 0 && paths.every((path) => path === 'src/feature.ts')
          ? {
              ...common,
              type: 'ALLOW_ONCE' as const,
              proofId: `xhbpp_omp_p1c_real_${decisionIndex}`,
              proofDigest: `sha256:${String(decisionIndex).padStart(64, '0')}`,
            }
          : {
              ...common,
              type: 'DENY' as const,
              reasonCode: 'OMP_P1C_SCOPE_UNVERIFIED',
            }
      })
    }), 180_000)
    await monitor.close()

    if (outcome.state !== 'SUCCEEDED') {
      await runtime.close()
      workspaceRegistry.close()
      throw new Error([
        'OMP_P1C_REAL_JOURNEY_FAILED',
        outcome.state,
        outcome.reasonCode,
        JSON.stringify(permissionEvidence),
        JSON.stringify(processFactory.trace),
      ].join(':'))
    }

    const worktreeContent = readFileSync(join(prepared.handle.rootPath, 'src', 'feature.ts'), 'utf8')
    const projectContent = readFileSync(join(projectRoot, 'src', 'feature.ts'), 'utf8')
    const diffCheck = git(prepared.handle.rootPath, ['diff', '--check'])
    const capture = await workspaces.captureTaskPatch(ATTEMPT_ID)
    const bindingVerified = await recovery.verifyCandidateBinding({
      attemptId: ATTEMPT_ID,
      runtimeSessionId: outcome.runtimeSessionId,
      runtimeCandidateDigest: outcome.candidateDigest,
      hostResultTreeHash: capture.resultTreeHash,
    })
    await runtime.close()
    workspaceRegistry.close()

    expect(outcome).toMatchObject({
      state: 'SUCCEEDED',
      candidateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(permissionEvidence.some((event) => event.paths.includes('src/feature.ts'))).toBe(true)
    expect(worktreeContent).toMatch(/value\s*=\s*2/)
    expect(projectContent).toBe('export const value = 1')
    expect(diffCheck).toBe('')
    expect(capture.resultTreeHash).toBe(outcome.candidateDigest)
    expect(bindingVerified).toBe(true)
  }, 240_000)
})

function createProductionAdapter(input: {
  root: string
  workspaces: GitAttemptWorkspaceServiceV1
  recovery: SqliteOmpAcpRecoveryStoreV1
  factory: JourneyTransportFactory
  receiptDigest?: string
}) {
  const launch = trustedLaunch(input.root, input.receiptDigest)
  return createOmpAcpRuntimeAdapterV1({
    payloadResolver: payloadResolver('change the file'),
    workspaceResolver: new KimiAttemptWorkspaceResolverV1(input.workspaces, join(input.root, 'unused-kimi-home')),
    runtimeStateDir: join(input.root, 'omp-state'),
    probe: { async findExecutable() { throw new Error('PATH_PROBE_MUST_NOT_RUN') } },
    transportFactory: input.factory,
    productionGate: {
      enabled: true,
      selection: ompAcpProductionSelectionV1(),
      trustedLaunch: launch,
      recoveryStore: input.recovery,
      candidateInspector: new TaskHubOmpCandidateInspectorV1(input.workspaces),
    },
  })
}

function trustedLaunch(root: string, receiptDigest = RECEIPT_DIGEST): OmpAcpTrustedLaunchPortV1 {
  const entry = join(root, 'trusted-package', 'dist', 'cli.js')
  mkdirSync(join(root, 'trusted-package', 'dist'), { recursive: true })
  writeFileSync(entry, '// fake transport owns execution\n', 'utf8')
  return {
    async inspectLaunch() {
      return {
        available: true as const,
        command: process.execPath,
        args: [entry, ...OMP_ACP_SAFE_ARGS_V1],
        version: OMP_ACP_APPROVED_VERSION_V1,
        installationReceiptDigest: receiptDigest,
      }
    },
  }
}

function productionRequest(
  workspace: RuntimeCreateOrResumeRequestV1['workspace'],
  promptText = 'change the file',
): RuntimeCreateOrResumeRequestV1 {
  const selection = ompAcpProductionSelectionV1()
  const productionPolicy = {
    rejectDiagnosticOnly: true,
    allowedSelections: [selection],
  } satisfies RuntimeProductionPolicyV1
  const prompt = Buffer.from(promptText, 'utf8')
  return {
    requestId: 'xhbrr_omp_p1c',
    scope: {
      projectId: PROJECT_ID,
      sessionKey: 'xgs_omp_p1c',
      sessionMode: 'CODING',
      flowId: FLOW_ID,
      taskRunId: TASK_RUN_ID,
      attemptId: ATTEMPT_ID,
      attemptDigest: `sha256:${'9'.repeat(64)}`,
      workspaceReceiptId: 'xhbwr_omp_p1c',
      workspaceReceiptDigest: `sha256:${'d'.repeat(64)}`,
    },
    workspace,
    selection,
    productionPolicy,
    promptEnvelopeRef: {
      refId: 'xhbpe_omp_p1c',
      digest: digestBytes(prompt),
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
    codingRole: {
      schemaVersion: 1,
      profileId: 'xiaogui.role.implement.omp-p1c',
      role: 'IMPLEMENT',
      modelSelector: 'kimi-coding/k3-256k',
      runtimePolicyId: 'xiaogui.runtime.omp-p1c',
      effectiveToolAllowlist: ['read', 'edit', 'write'],
      profileDigest: `sha256:${'a'.repeat(64)}`,
      snapshotDigest: `sha256:${'b'.repeat(64)}`,
    },
  }
}

function syntheticRequest(root: string): RuntimeCreateOrResumeRequestV1 {
  return productionRequest({
    attemptWorktreeId: 'xhbwt_omp_p1c',
    worktreeRootDigest: digestBytes(Buffer.from(root)),
    baseRevisionDigest: `sha256:${'e'.repeat(64)}`,
    targetProjectRootDigest: `sha256:${'f'.repeat(64)}`,
    writePolicy: 'ATTEMPT_WORKTREE_ONLY',
  })
}

function payloadResolver(prompt: string): TrustedRuntimePayloadResolverV1 {
  return {
    async resolvePrompt(ref) {
      return {
        promptEnvelopeRef: ref,
        redactedPreviewDigest: `sha256:${'1'.repeat(64)}`,
        payloadBytes: Buffer.from(prompt, 'utf8'),
      }
    },
    async resolveMessage(ref) {
      return {
        messageEnvelopeRef: ref,
        redactedPreviewDigest: `sha256:${'2'.repeat(64)}`,
        payloadBytes: Buffer.from('continue', 'utf8'),
      }
    },
    async *resolveTextStream() {},
    async resolveCandidateFile(ref) {
      return {
        candidateFileRef: ref,
        relativePathDigest: `sha256:${'3'.repeat(64)}`,
        contentDigest: `sha256:${'4'.repeat(64)}`,
        payloadBytes: new Uint8Array(),
      }
    },
    async toM2ChangeSetCandidate(input) {
      return { changeSetCandidateId: 'unused', digest: input.candidateDigest }
    },
  }
}

function sealedTaskChangeSet(
  audit: Awaited<ReturnType<TaskCandidateAuditServiceV1['captureTaskCandidate']>>,
): TaskChangeSetV1 {
  const withoutDigest = {
    kind: 'TASK' as const,
    taskChangeSetId: 'xhbcs_omp_p1c' as TaskChangeSetId,
    version: 1 as const,
    flowId: FLOW_ID,
    planRevisionId: 'xhbpr_omp_p1c' as PlanRevisionId,
    taskRunId: TASK_RUN_ID,
    attemptId: ATTEMPT_ID,
    verificationAttemptId: 'xhbva_omp_p1c' as VerificationAttemptId,
    candidateId: audit.candidate.candidateId as TaskChangeSetCandidateId,
    inputTreeHash: audit.candidate.inputTreeHash,
    resultTreeHash: audit.candidate.resultTreeHash,
    ancestorTaskChangeSetIds: audit.ancestorTaskChangeSetIds,
    patchArtifactId: audit.patchArtifact.artifactId,
    evidenceBundleId: 'xhbev_omp_p1c' as EvidenceBundleId,
    qaResultId: 'xhbqa_omp_p1c' as QaResultId,
    qaConfigVersion: 'xiaogui.coding.task.v1',
    createdAt: SETTLED_AT as IsoDateTime,
  }
  return { ...withoutDigest, digest: taskChangeSetDigestV1(withoutDigest) }
}

function inertRecoveryStore() {
  return {
    durable: true as const,
    async bind() {},
    async settle() {},
    async read() { return null },
    async readByRequestId() { return null },
    close() {},
  }
}

class JourneyTransport implements AcpTransportV1 {
  private options?: AcpTransportStartOptionsV1
  readonly loadCalls: Array<{ sessionId: string; cwd: string }> = []
  readonly configCalls: Array<{ sessionId: string; configId: string; value: string }> = []
  promptCalls = 0

  constructor(private readonly script?: (transport: JourneyTransport) => Promise<void>) {}

  async start(options: AcpTransportStartOptionsV1) {
    this.options = options
    return {
      protocolVersion: 1,
      agentInfo: { name: 'oh-my-pi', version: OMP_ACP_APPROVED_VERSION_V1 },
      agentCapabilities: { loadSession: true },
    }
  }

  async newSession() { return { sessionId: VENDOR_SESSION_ID } }
  async loadSession(sessionId: string, cwd: string) { this.loadCalls.push({ sessionId, cwd }) }
  async setConfigOption(sessionId: string, configId: string, value: string) {
    this.configCalls.push({ sessionId, configId, value })
  }
  async prompt() {
    this.promptCalls += 1
    await this.script?.(this)
    return { stopReason: 'end_turn' }
  }
  async cancel() {}
  async dispose() {}

  requestPermission(params: AcpRequestPermissionParamsV1): Promise<AcpRequestPermissionResultV1> {
    if (!this.options) throw new Error('transport not started')
    return this.options.onPermissionRequest(params)
  }

  async requestElicitation(params: AcpElicitationCreateParamsV1): Promise<AcpElicitationCreateResultV1> {
    if (!this.options) throw new Error('transport not started')
    const handler = this.options.requestHandlers.get('elicitation/create')
    if (!handler) throw new Error('elicitation handler missing')
    return await handler(params) as AcpElicitationCreateResultV1
  }

  sessionUpdate(params: AcpSessionUpdateParamsV1): void {
    this.options?.onSessionUpdate(params)
  }
}

class TracingProcessTransportFactory implements AcpTransportFactoryV1 {
  readonly trace: string[] = []
  private readonly inner = new AcpProcessTransportFactoryV1()

  create(command: string, args: readonly string[], cwd: string, options?: AcpTransportCreateOptionsV1): AcpTransportV1 {
    const transport = this.inner.create(command, args, cwd, options)
    const trace = this.trace
    return {
      async start(startOptions) {
        const handlers = new Map(startOptions.requestHandlers)
        const elicitation = handlers.get('elicitation/create')
        if (elicitation) {
          handlers.set('elicitation/create', async (params) => {
            trace.push(`elicitation:${summarizeElicitation(params)}`)
            const result = await elicitation(params)
            trace.push(`elicitation-result:${summarizeElicitationResult(result)}`)
            return result
          })
        }
        return transport.start({
          ...startOptions,
          requestHandlers: handlers,
          onSessionUpdate(params) {
            if (params.update?.sessionUpdate === 'tool_call' || params.update?.sessionUpdate === 'tool_call_update') {
              trace.push(`update:${params.update.sessionUpdate}:${params.update.kind ?? ''}:${params.update.status ?? ''}`)
            }
            startOptions.onSessionUpdate(params)
          },
        })
      },
      newSession: (root) => transport.newSession(root),
      loadSession: (sessionId, root) => transport.loadSession(sessionId, root),
      ...(transport.setConfigOption
        ? { setConfigOption: (sessionId: string, configId: string, value: string) => transport.setConfigOption!(sessionId, configId, value) }
        : {}),
      prompt: (sessionId, prompt) => transport.prompt(sessionId, prompt),
      cancel: (sessionId) => transport.cancel(sessionId),
      dispose: () => transport.dispose(),
    }
  }
}

function summarizeElicitation(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'invalid'
  const value = params as AcpElicitationCreateParamsV1
  return JSON.stringify({ mode: value.mode, requestedSchema: value.requestedSchema })
}

function summarizeElicitationResult(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'invalid'
  return JSON.stringify(result)
}

class JourneyTransportFactory implements AcpTransportFactoryV1 {
  readonly transports: JourneyTransport[] = []

  constructor(private readonly script?: (transport: JourneyTransport) => Promise<void>) {}

  create(_command: string, _args: readonly string[], _cwd: string, _options?: AcpTransportCreateOptionsV1) {
    const transport = new JourneyTransport(this.script)
    this.transports.push(transport)
    return transport
  }
}

function createGitProject(root: string): string {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'feature.ts'), 'export const value = 1', 'utf8')
  git(root, ['init'])
  git(root, ['config', 'user.email', 'xiaogui@example.test'])
  git(root, ['config', 'user.name', 'Xiaogui Test'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'baseline'])
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

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function trackClose<T extends { close(): void | Promise<void> }>(resource: T): T {
  closers.push(() => resource.close())
  return resource
}

function requiredAbsoluteEnv(name: string): string {
  const value = process.env[name]
  if (!value || !/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) throw new Error(`${name}_REQUIRED`)
  return value
}

function testDigestJson(value: unknown): string {
  return digestBytes(Buffer.from(JSON.stringify(value), 'utf8'))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('OMP_P1C_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
