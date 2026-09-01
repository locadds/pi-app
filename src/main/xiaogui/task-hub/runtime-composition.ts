import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type {
  AgentRuntimeAdapterV1,
  AgentRuntimeRegistryV1,
  RuntimeAdapterSelectionV1,
  RuntimeRoutingPolicyV1,
} from '@shared/xiaogui-agent-runtime'
import type { SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import { KimiAttemptWorkspaceResolverV1 } from '../agent-runtime/kimi-attempt-workspace'
import {
  createKimiAcpRuntimeAdapterV1,
  kimiAcpCapabilityDigestForVersionV1,
  type KimiAcpRuntimeAdapterV1,
  type KimiAcpProbeV1,
} from '../agent-runtime/kimi-adapter'
import { KIMI_ACP_APPROVED_VERSION_V1 } from '../agent-runtime/acp/kimi-tool-policy'
import type { AcpTransportFactoryV1 } from '../agent-runtime/acp/types'
import { prepareKimiProductionHomeV1 } from '../agent-runtime/kimi-production-home'
import { createAgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { createAgentRuntimeRegistryV1 } from '../agent-runtime/runtime-registry'
import {
  createCollaborationHubApplicationV1,
  type CollaborationHubApplicationV1,
} from './application'
import {
  AttemptExecutionInputStoreV1,
  type ResolvedAttemptExecutionInputV1,
  type StageAttemptExecutionInputV1,
} from './attempt-execution-input'
import {
  GitAttemptWorkspaceServiceV1,
  SqliteAttemptWorkspaceRegistryV1,
  type ProjectWorkspaceResolverV1,
} from './attempt-workspace'
import { GitExecutionBaselineProviderV1 } from './git-execution-baseline'
import { GitDerivedExecutionBaselineProviderV1 } from './git-derived-execution-baseline'
import { PrivateRuntimePayloadVaultV1 } from './private-payload-vault'
import { MainProjectWorkspaceResolverV1 } from './project-workspace-resolver'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import { XiaoguiTaskExecutionOrchestratorV1 } from './execution-orchestrator'
import { TaskCandidateAuditServiceV1 } from './task-candidate-audit'
import { FixedTypecheckVerificationPortV1 } from './verification-port'
import { createRuntimeOutcomeMonitorV1, type RuntimeOutcomeMonitorV1 } from './runtime-outcome-monitor'
import { createTaskVerificationCoordinatorV1, type TaskVerificationCoordinatorV1 } from './task-verification-coordinator'
import { MainProcessChangeApplyPortV1, SqliteDeliveryApplyAttemptRegistryV1 } from './change-apply'
import { createXiaoguiDeliveryWorkflowV1, type XiaoguiDeliveryWorkflowV1 } from './delivery-workflow'
import {
  deactivatePiE2eScriptedRuntimeLaunchV1,
  PiE2eWorkspaceScriptedRuntimeAdapterV1,
  type PiE2eScriptedRuntimeLaunchV1,
} from './pi-e2e-scripted-runtime'
import { CodingPermissionModuleV1 } from '../coding-extensions/permission-module'
import { MainProcessCodingPermissionUIAdapterV1 } from '../coding-extensions/permission-ui-adapter'
import { CodingAttemptPlanModuleV1 } from '../coding-extensions/attempt-plan-module'
import {
  CodingAttemptReviewModuleV1,
  GitAttemptReviewDiffPortV1,
} from '../coding-extensions/attempt-review-module'
import { CodingRoleProfileModuleV1 } from '../coding-extensions/role-profile-module'

export interface XiaoguiRuntimeCompositionOptionsV1 {
  readonly userDataDir: string
  readonly productionEnabled: boolean
  readonly lookup: SessionScopeLookupV1
  readonly projectResolver?: ProjectWorkspaceResolverV1
  readonly kimiProbe?: KimiAcpProbeV1
  readonly kimiTransportFactory?: AcpTransportFactoryV1
  readonly additionalRuntimeAdapters?: readonly AgentRuntimeAdapterV1[]
  /** Opaque, process-launch-gated E2E seam. Forged launch objects are rejected by the adapter. */
  readonly piE2eScriptedRuntimeLaunch?: PiE2eScriptedRuntimeLaunchV1
  readonly runtimeRoutingPolicy?: RuntimeRoutingPolicyV1
  readonly now?: () => string
}

/**
 * Main-process-only deep Module for the Task Hub execution path. Callers stage
 * private inputs at this seam, then drive the public application Interface.
 */
export interface XiaoguiRuntimeCompositionV1 {
  readonly application: CollaborationHubApplicationV1
  readonly taskExecution: XiaoguiTaskExecutionOrchestratorV1
  readonly delivery: XiaoguiDeliveryWorkflowV1
  readonly codingPlan: CodingAttemptPlanModuleV1
  readonly codingReview: CodingAttemptReviewModuleV1
  readonly codingRoles: CodingRoleProfileModuleV1
  stageAttemptInput(input: StageAttemptExecutionInputV1): ResolvedAttemptExecutionInputV1
  close(): Promise<void>
}

const KIMI_PRODUCTION_SELECTION_V1 = {
  adapterId: 'kimi-acp',
  runtimeKind: 'KIMI',
  protocol: 'ACP',
  capabilityDigest: kimiAcpCapabilityDigestForVersionV1(KIMI_ACP_APPROVED_VERSION_V1),
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
  diagnosticOnly: false,
  stream: 'POLL',
  interrupt: 'BEST_EFFORT',
  inspect: 'RECONCILE',
} satisfies RuntimeAdapterSelectionV1

export function createXiaoguiRuntimeCompositionV1(
  options: XiaoguiRuntimeCompositionOptionsV1,
): XiaoguiRuntimeCompositionV1 {
  const userDataDir = resolveUserDataDirectory(options.userDataDir)
  const xiaoguiDir = join(userDataDir, 'xiaogui')
  const taskHubDir = join(xiaoguiDir, 'task-hub')
  const hubDbPath = join(userDataDir, 'xiaogui-task-hub-m2a.sqlite')
  mkdirSync(taskHubDir, { recursive: true })

  let workspaceRegistry: SqliteAttemptWorkspaceRegistryV1 | undefined
  let payloadVault: PrivateRuntimePayloadVaultV1 | undefined
  let inputStore: AttemptExecutionInputStoreV1 | undefined
  let application: CollaborationHubApplicationV1 | undefined
  let kimiAdapter: KimiAcpRuntimeAdapterV1 | undefined
  let runtimeRegistry: AgentRuntimeRegistryV1 | undefined
  let taskExecution: XiaoguiTaskExecutionOrchestratorV1 | undefined
  let runtimeMonitor: RuntimeOutcomeMonitorV1 | undefined
  let taskVerificationCoordinator: TaskVerificationCoordinatorV1 | undefined
  let deliveryWorkflow: XiaoguiDeliveryWorkflowV1 | undefined
  let deliveryApplyRegistry: SqliteDeliveryApplyAttemptRegistryV1 | undefined
  let codingPermissionModule: CodingPermissionModuleV1 | undefined
  let codingAttemptPlanModule: CodingAttemptPlanModuleV1 | undefined
  let codingReviewStore: CollaborationHubSqliteStoreV1 | undefined
  let codingRoleProfiles: CodingRoleProfileModuleV1 | undefined

  try {
    const projectResolver = options.projectResolver ?? new MainProjectWorkspaceResolverV1()
    const baselineProvider = new GitExecutionBaselineProviderV1(projectResolver)
    workspaceRegistry = new SqliteAttemptWorkspaceRegistryV1({
      dbPath: join(taskHubDir, 'attempt-workspaces.sqlite'),
    })
    const attemptWorkspaces = new GitAttemptWorkspaceServiceV1(workspaceRegistry, projectResolver, {
      managedRoot: join(xiaoguiDir, 'attempt-worktrees'),
    })
    const derivedBaselineProvider = new GitDerivedExecutionBaselineProviderV1({
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      projectResolver,
      managedRoot: join(xiaoguiDir, 'derived-baseline-worktrees'),
      now: options.now,
    })
    payloadVault = new PrivateRuntimePayloadVaultV1({
      dbPath: join(taskHubDir, 'private-runtime-payloads.sqlite'),
      now: options.now,
    })
    inputStore = new AttemptExecutionInputStoreV1({
      dbPath: join(taskHubDir, 'attempt-execution-inputs.sqlite'),
      payloadVault,
      workspace: attemptWorkspaces,
      now: options.now,
    })

    const productionHome = prepareKimiProductionHomeV1({
      enabled: options.productionEnabled,
      userDataDir,
    })
    const kimiWorkspaceResolver = new KimiAttemptWorkspaceResolverV1(
      attemptWorkspaces,
      productionHome.enabled
        ? productionHome.kimiCodeHome
        : join(xiaoguiDir, 'agent-runtime', 'kimi-v1'),
    )
    kimiAdapter = createKimiAcpRuntimeAdapterV1({
      payloadResolver: payloadVault,
      workspaceResolver: kimiWorkspaceResolver,
      probe: options.kimiProbe,
      transportFactory: options.kimiTransportFactory,
      productionGate: options.productionEnabled
        ? { enabled: true, selection: KIMI_PRODUCTION_SELECTION_V1 }
        : { enabled: false },
    })
    runtimeRegistry = createAgentRuntimeRegistryV1()
    void runtimeRegistry.register(kimiAdapter)
    const piE2eAdapter = options.piE2eScriptedRuntimeLaunch
      ? new PiE2eWorkspaceScriptedRuntimeAdapterV1(
          attemptWorkspaces,
          options.piE2eScriptedRuntimeLaunch,
        )
      : undefined
    if (piE2eAdapter) void runtimeRegistry.register(piE2eAdapter)
    for (const adapter of options.additionalRuntimeAdapters ?? []) {
      void runtimeRegistry.register(adapter)
    }
    const runtimeHost = Object.assign(createAgentRuntimeHostV1(runtimeRegistry), {
      resolve: runtimeRegistry.resolve.bind(runtimeRegistry),
    })

    const fixedVerificationPort = new FixedTypecheckVerificationPortV1()
    taskVerificationCoordinator = createTaskVerificationCoordinatorV1({
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      candidateAudit: new TaskCandidateAuditServiceV1(attemptWorkspaces),
      verificationPort: fixedVerificationPort,
      projectResolver,
      now: options.now,
    })
    runtimeMonitor = createRuntimeOutcomeMonitorV1({ runtime: runtimeHost })
    application = createCollaborationHubApplicationV1({
      lookup: options.lookup,
      // Keep the existing desktop database location so installing the runtime
      // composition does not make previously created plans disappear.
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      ...(options.productionEnabled || piE2eAdapter
        ? {
            agentRuntime: runtimeHost,
            ...(options.productionEnabled && !piE2eAdapter
              ? { agentSelection: KIMI_PRODUCTION_SELECTION_V1 }
              : {}),
            agentRoutingPolicy: options.runtimeRoutingPolicy ?? {
              mode: 'CODING' as const,
              requiredCapabilities: ['CODING.GIT.CHANGESET' as const, 'CODING.TYPESCRIPT' as const],
              dataEgressPolicy: 'EXTERNAL_ALLOWED' as const,
              priorityAdapterIds: [KIMI_PRODUCTION_SELECTION_V1.adapterId],
              requireProductionApproval: true as const,
            },
          }
        : {}),
      baselineProvider,
      derivedBaselineProvider,
      workspaceBridge: inputStore.bridge,
      runtimePromptVault: inputStore,
      taskVerificationCoordinator,
      now: options.now,
    })

    codingPermissionModule = new CodingPermissionModuleV1({
      dbPath: hubDbPath,
      // The UI Adapter dismisses first; the Module's longer timeout remains a
      // fail-closed backstop for any future Adapter implementation.
      ui: new MainProcessCodingPermissionUIAdapterV1({ timeoutMs: 55_000 }),
      timeoutMs: 60_000,
      now: options.now,
    })
    codingAttemptPlanModule = new CodingAttemptPlanModuleV1({
      dbPath: hubDbPath,
      now: options.now,
    })
    const codingRoleDir = join(xiaoguiDir, 'coding-roles')
    mkdirSync(codingRoleDir, { recursive: true })
    codingRoleProfiles = new CodingRoleProfileModuleV1({
      dbPath: join(codingRoleDir, 'role-profiles-v1.sqlite'),
      now: options.now,
    })
    codingReviewStore = new CollaborationHubSqliteStoreV1(hubDbPath)
    const codingAttemptReviewModule = new CodingAttemptReviewModuleV1({
      app: application,
      store: codingReviewStore,
      workspace: attemptWorkspaces,
      diffPort: new GitAttemptReviewDiffPortV1(),
    })
    taskExecution = new XiaoguiTaskExecutionOrchestratorV1({
      dbPath: hubDbPath,
      application,
      inputStage: { stageAttemptInput: (input) => inputStore!.stage(input) },
      fileScopeResolver: attemptWorkspaces,
      runtimeMonitor,
      runtimeBindingRestorer: async ({ attemptId, runtimeSessionId }) => {
        const store = new CollaborationHubSqliteStoreV1(hubDbPath)
        try {
          const outbox = store.agentDispatchOutbox(attemptId)
          if (!outbox?.runtime_request_json) return { ok: false, reasonCode: 'RUNTIME_BINDING_MISSING' }
          const request = JSON.parse(outbox.runtime_request_json) as { selection?: RuntimeAdapterSelectionV1 }
          return request.selection && typeof request.selection.adapterId === 'string'
            ? runtimeRegistry!.restoreBinding(runtimeSessionId, request.selection)
            : { ok: false, reasonCode: 'RUNTIME_BINDING_INVALID' }
        } catch {
          return { ok: false, reasonCode: 'RUNTIME_BINDING_INVALID' }
        } finally {
          store.close()
        }
      },
      verificationCoordinator: taskVerificationCoordinator,
      permissionModule: codingPermissionModule,
      permissionScope: attemptWorkspaces,
      attemptPlanGate: codingAttemptPlanModule,
      attemptRoleGate: {
        async isAttemptRoleExecutable(attemptId) {
          try {
            return codingRoleProfiles!.readAttemptBinding(attemptId)?.snapshot.role === 'IMPLEMENT'
          } catch {
            return false
          }
        },
      },
      now: options.now,
    })
    void taskExecution.recover().catch(() => undefined)
    deliveryApplyRegistry = new SqliteDeliveryApplyAttemptRegistryV1({
      dbPath: join(taskHubDir, 'delivery-apply-attempts.sqlite'),
    })
    deliveryWorkflow = createXiaoguiDeliveryWorkflowV1({
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      baselineProvider,
      projectResolver,
      deliveryManagedRoot: join(xiaoguiDir, 'delivery-worktrees'),
      verificationPort: fixedVerificationPort,
      applyPort: new MainProcessChangeApplyPortV1({ projectResolver, registry: deliveryApplyRegistry }),
      now: options.now,
    })
    void deliveryWorkflow.recover().catch(() => undefined)

    return createCompositionInterface(
      application,
      taskExecution,
      deliveryWorkflow,
      deliveryApplyRegistry,
      runtimeRegistry,
      inputStore,
      payloadVault,
      workspaceRegistry,
      codingPermissionModule,
      codingAttemptPlanModule,
      codingAttemptReviewModule,
      codingRoleProfiles,
      codingReviewStore,
      options.piE2eScriptedRuntimeLaunch,
    )
  } catch (error) {
    closeQuietly(taskExecution)
    closeQuietly(runtimeMonitor)
    closeQuietly(taskVerificationCoordinator)
    closeQuietly(deliveryWorkflow)
    closeQuietly(deliveryApplyRegistry)
    closeQuietly(runtimeRegistry)
    closeQuietly(application)
    closeQuietly(inputStore)
    closeQuietly(payloadVault)
    closeQuietly(workspaceRegistry)
    closeQuietly(codingPermissionModule)
    closeQuietly(codingAttemptPlanModule)
    closeQuietly(codingRoleProfiles)
    closeQuietly(codingReviewStore)
    if (options.piE2eScriptedRuntimeLaunch) {
      deactivatePiE2eScriptedRuntimeLaunchV1(options.piE2eScriptedRuntimeLaunch)
    }
    throw error
  }
}

function createCompositionInterface(
  application: CollaborationHubApplicationV1,
  taskExecution: XiaoguiTaskExecutionOrchestratorV1,
  delivery: XiaoguiDeliveryWorkflowV1,
  deliveryApplyRegistry: SqliteDeliveryApplyAttemptRegistryV1,
  runtimeRegistry: AgentRuntimeRegistryV1,
  inputStore: AttemptExecutionInputStoreV1,
  payloadVault: PrivateRuntimePayloadVaultV1,
  workspaceRegistry: SqliteAttemptWorkspaceRegistryV1,
  codingPermissionModule: CodingPermissionModuleV1,
  codingAttemptPlanModule: CodingAttemptPlanModuleV1,
  codingAttemptReviewModule: CodingAttemptReviewModuleV1,
  codingRoleProfiles: CodingRoleProfileModuleV1,
  codingReviewStore: CollaborationHubSqliteStoreV1,
  piE2eLaunch: PiE2eScriptedRuntimeLaunchV1 | undefined,
): XiaoguiRuntimeCompositionV1 {
  let closed = false
  let closePromise: Promise<void> | undefined

  return {
    application,
    taskExecution,
    delivery,
    codingPlan: codingAttemptPlanModule,
    codingReview: codingAttemptReviewModule,
    codingRoles: codingRoleProfiles,
    stageAttemptInput(input) {
      if (closed) throw new Error('XIAOGUI_RUNTIME_COMPOSITION_CLOSED')
      return inputStore.stage(input)
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      closePromise = (async () => {
        try {
          await taskExecution.close()
          await delivery.close()
          await closeAll([
            deliveryApplyRegistry,
            runtimeRegistry,
            application,
            inputStore,
            payloadVault,
            workspaceRegistry,
            codingPermissionModule,
            codingAttemptPlanModule,
            codingRoleProfiles,
            codingReviewStore,
          ])
        } finally {
          if (piE2eLaunch) deactivatePiE2eScriptedRuntimeLaunchV1(piE2eLaunch)
        }
      })()
      return closePromise
    },
  }
}

function resolveUserDataDirectory(value: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !isAbsolute(value)) {
    throw new Error('XIAOGUI_USER_DATA_DIR_INVALID')
  }
  const lexical = resolve(value)
  let real: string
  try {
    real = realpathSync.native(lexical)
    if (!lstatSync(real).isDirectory() || pathKey(real) !== pathKey(lexical)) {
      throw new Error('XIAOGUI_USER_DATA_DIR_INVALID')
    }
  } catch {
    throw new Error('XIAOGUI_USER_DATA_DIR_INVALID')
  }
  return real
}

async function closeAll(resources: readonly { close(): void | Promise<void> }[]): Promise<void> {
  const closes = resources.map((resource) => {
    try {
      return Promise.resolve(resource.close())
    } catch (error) {
      return Promise.reject(error)
    }
  })
  const results = await Promise.allSettled(closes)
  const firstFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (firstFailure) throw firstFailure.reason
}

function closeQuietly(resource: { close(): void | Promise<void> } | undefined): void {
  try {
    const result = resource?.close()
    if (result instanceof Promise) void result.catch(() => undefined)
  } catch {
    // Preserve the construction failure after attempting every owned close.
  }
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}
