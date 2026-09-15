import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type {
  AgentRuntimeAdapterV1,
  AgentRuntimeRegistryV1,
  RuntimeAdapterSelectionV1,
  RuntimeCodingRoleBindingV1,
  RuntimeRoutingPolicyV1,
} from '@shared/xiaogui-agent-runtime'
import type { SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'
import { taskChangeSetDigestV1 } from '@shared/xiaogui-task-verification'
import type { AttemptId, FlowId } from '@shared/xiaogui-collaboration-hub'
import type { ArtifactId, TaskChangeSetId } from '@shared/xiaogui-task-verification'

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
import { PiRuntimeAdapterV1, PI_PRODUCTION_SELECTION_V1, type PiRuntimeOptionsV1 } from '../agent-runtime/pi-adapter'
import { createAgentRuntimeHostV1 } from '../agent-runtime/runtime-host'
import { createAgentRuntimeRegistryV1 } from '../agent-runtime/runtime-registry'
import {
  createCollaborationHubApplicationV1,
  type CollaborationHubApplicationV1,
} from './application'
import {
  AttemptExecutionInputStoreV1,
  attemptWorktreeAuthorizationDigestV2,
  type ResolvedAttemptExecutionInput,
  type ResolvedAttemptExecutionInputV1,
  type StageAttemptExecutionInputV1,
} from './attempt-execution-input'
import type { HubTaskAcceptAndExecuteTrustedPortV2 } from '../hub-task/worker-service'
import {
  GitAttemptWorkspaceServiceV1,
  SqliteAttemptWorkspaceRegistryV1,
  digestBytes as workspaceDigestBytes,
  digestJson as workspaceDigestJson,
  type AttemptFileGrantV1,
  type AttemptWorkspaceBaselineSourceBindingV1,
  type AttemptWorkspaceBaselineSourceResolverV1,
  type AttemptWorkspacePrepareRequestV2,
  type ProjectWorkspaceResolverV1,
  projectWorktreeIdentityV2,
} from './attempt-workspace'
import { payloadDigest } from './digest'
import { GitExecutionBaselineProviderV1 } from './git-execution-baseline'
import { GitDerivedExecutionBaselineProviderV1 } from './git-derived-execution-baseline'
import { PrivateRuntimePayloadVaultV1 } from './private-payload-vault'
import { MainProjectWorkspaceResolverV1 } from './project-workspace-resolver'
import { CollaborationHubSqliteStoreV1, hasHubAcceptanceRecoverySchemaV1 } from './sqlite-store'
import { XiaoguiTaskExecutionOrchestratorV1 } from './execution-orchestrator'
import { TaskCandidateAuditServiceV1 } from './task-candidate-audit'
import { FixedTypecheckVerificationPortV1, ModeTaskVerificationPortV1 } from './verification-port'
import { createRuntimeOutcomeMonitorV1, type RuntimeOutcomeMonitorV1 } from './runtime-outcome-monitor'
import { createTaskVerificationCoordinatorV1, MainUnsettledTaskVerificationPortV1, type TaskVerificationCoordinatorV1 } from './task-verification-coordinator'
import { MainProcessChangeApplyPortV1, MainProcessChangeApplyPortV2, SqliteDeliveryApplyAttemptRegistryV1 } from './change-apply'
import { createXiaoguiDeliveryWorkflowV1, type XiaoguiDeliveryWorkflowV1 } from './delivery-workflow'
import {
  deactivatePiE2eScriptedRuntimeLaunchV1,
  PiE2eWorkspaceScriptedRuntimeAdapterV1,
  type PiE2eScriptedRuntimeLaunchV1,
} from './pi-e2e-scripted-runtime'
import { CodingPermissionModuleV1 } from '../coding-extensions/permission-module'
import { CodingPermissionModeModuleV1 } from '../coding-extensions/permission-mode-module'
import { MainProcessCodingPermissionUIAdapterV1 } from '../coding-extensions/permission-ui-adapter'
import { CodingAuthorizationModuleV2 } from '../coding-extensions/coding-authorization-module'
import { MainProcessDirectCodingPermissionUIAdapterV3 } from '../coding-extensions/direct-permission-ui-adapter'
import { workerManager } from '../../worker-manager'
import { CodingAttemptPlanModuleV1 } from '../coding-extensions/attempt-plan-module'
import {
  CodingAttemptReviewModuleV1,
  GitAttemptReviewDiffPortV1,
} from '../coding-extensions/attempt-review-module'
import { CodingRoleProfileModuleV1 } from '../coding-extensions/role-profile-module'

export interface XiaoguiRuntimeCompositionOptionsV1 {
  readonly userDataDir: string
  readonly productionEnabled: boolean
  readonly piWorkerFactory?: PiRuntimeOptionsV1['workerFactory']
  readonly lookup: SessionScopeLookupV1
  readonly projectResolver?: ProjectWorkspaceResolverV1
  readonly kimiProbe?: KimiAcpProbeV1
  readonly kimiTransportFactory?: AcpTransportFactoryV1
  readonly additionalRuntimeAdapters?: readonly AgentRuntimeAdapterV1[]
  /** Opaque, process-launch-gated E2E seam. Forged launch objects are rejected by the adapter. */
  readonly piE2eScriptedRuntimeLaunch?: PiE2eScriptedRuntimeLaunchV1
  readonly runtimeRoutingPolicy?: RuntimeRoutingPolicyV1
  /** Main-process preference seam; omission keeps the safest deterministic default. */
  readonly codingPermissionModeProvider?: () => unknown
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
  /** Shared authorization authority; Direct and TaskHub enter through separate subject Adapters. */
  readonly codingAuthorization: CodingAuthorizationModuleV2
  readonly acceptAndExecuteTrustedPortV2: HubTaskAcceptAndExecuteTrustedPortV2
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

function runtimeCodingRoleBinding(
  binding: NonNullable<ReturnType<CodingRoleProfileModuleV1['readAttemptBinding']>>,
): RuntimeCodingRoleBindingV1 {
  return Object.freeze({
    schemaVersion: 1,
    profileId: binding.snapshot.profileId,
    role: binding.snapshot.role,
    modelSelector: binding.snapshot.modelSelector,
    runtimePolicyId: binding.snapshot.runtimePolicyId,
    effectiveToolAllowlist: Object.freeze([...binding.snapshot.effectiveToolAllowlist]),
    profileDigest: binding.snapshot.profileDigest,
    snapshotDigest: binding.snapshotDigest,
  })
}

export function createXiaoguiRuntimeCompositionV1(
  options: XiaoguiRuntimeCompositionOptionsV1,
): XiaoguiRuntimeCompositionV1 {
  const userDataDir = resolveUserDataDirectory(options.userDataDir)
  const xiaoguiDir = join(userDataDir, 'xiaogui')
  const taskHubDir = join(xiaoguiDir, 'task-hub')
  const hubDbPath = join(userDataDir, 'xiaogui-task-hub-m2a.sqlite')
  const recoveryDatabaseWasAuthoritative = hasHubAcceptanceRecoverySchemaV1(hubDbPath)
  const recoveryDatabaseIdentity = databaseIdentity(hubDbPath)
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
  let codingAuthorizationModule: CodingAuthorizationModuleV2 | undefined
  let codingPermissionModeModule: CodingPermissionModeModuleV1 | undefined
  let codingAttemptPlanModule: CodingAttemptPlanModuleV1 | undefined
  let codingReviewStore: CollaborationHubSqliteStoreV1 | undefined
  let codingRoleProfiles: CodingRoleProfileModuleV1 | undefined
  let unsettledVerification: MainUnsettledTaskVerificationPortV1 | undefined

  try {
    const projectResolver = options.projectResolver ?? new MainProjectWorkspaceResolverV1()
    const baselineProvider = new GitExecutionBaselineProviderV1(projectResolver)
    workspaceRegistry = new SqliteAttemptWorkspaceRegistryV1({
      dbPath: join(taskHubDir, 'attempt-workspaces.sqlite'),
    })
    const baselineSourceResolver = createMainAttemptWorkspaceBaselineSourceResolverV1(
      hubDbPath,
      () => inputStore,
    )
    const attemptWorkspaces = new GitAttemptWorkspaceServiceV1(workspaceRegistry, projectResolver, {
      managedRoot: join(xiaoguiDir, 'attempt-worktrees'),
      baselineSourceResolver,
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
    const piAdapter = new PiRuntimeAdapterV1({
      dbPath: join(taskHubDir, 'attempt-execution-inputs.sqlite'),
      workspace: attemptWorkspaces,
      payloads: payloadVault,
      workerFactory: options.piWorkerFactory,
      unsettledVerification: {
        verify: input => unsettledVerification
          ? unsettledVerification.verify(input as Parameters<MainUnsettledTaskVerificationPortV1['verify']>[0])
          : Promise.resolve({ verdict: 'OUTCOME_UNKNOWN' as const, candidateDigest: input.candidateDigest, reason: 'UNSETTLED_VERIFIER_UNAVAILABLE' }),
      },
    })
    void runtimeRegistry.register(piAdapter)
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

    const codingRoleDir = join(xiaoguiDir, 'coding-roles')
    mkdirSync(codingRoleDir, { recursive: true })
    codingRoleProfiles = new CodingRoleProfileModuleV1({
      dbPath: join(codingRoleDir, 'role-profiles-v1.sqlite'),
      now: options.now,
    })

    const fixedVerificationPort = new ModeTaskVerificationPortV1(
      new FixedTypecheckVerificationPortV1(),
      (request, context) => piAdapter.verificationContext(request, context),
    )
    const candidateAudit = new TaskCandidateAuditServiceV1(attemptWorkspaces, {
      verify: async (input) => input.runtimeSessionId.startsWith('xhbrs_pi_')
        ? input.runtimeCandidateDigest === input.hostResultTreeHash
        : true,
    }, async (attemptId) => (await attemptWorkspaces.runtimeAccess(attemptId))?.worktreeAuthorization ? 2 : 1)
    unsettledVerification = new MainUnsettledTaskVerificationPortV1(candidateAudit, fixedVerificationPort, projectResolver)
    taskVerificationCoordinator = createTaskVerificationCoordinatorV1({
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      candidateAudit,
      verificationPort: fixedVerificationPort,
      projectResolver,
      attemptRoleProvider: {
        readAttemptRole(attemptId) {
          return codingRoleProfiles!.readAttemptBinding(attemptId)?.snapshot.role ?? null
        },
      },
      onVerifiedTask: async (input) => {
        if (!deliveryWorkflow) throw new Error('DELIVERY_WORKFLOW_UNAVAILABLE')
        const selected = await deliveryWorkflow.selectVerifiedAttempt(input.address, input)
        if (!selected.ok) throw new Error(selected.error.code)
      },
      isAuthorizedV2Attempt: async (attemptId) => Boolean((await attemptWorkspaces.runtimeAccess(attemptId))?.worktreeAuthorization),
      now: options.now,
    })
    runtimeMonitor = createRuntimeOutcomeMonitorV1({ runtime: runtimeHost })
    application = createCollaborationHubApplicationV1({
      lookup: options.lookup,
      // Keep the existing desktop database location so installing the runtime
      // composition does not make previously created plans disappear.
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      ...{
            agentRuntime: runtimeHost,
            ...(!piE2eAdapter
              ? { agentSelection: PI_PRODUCTION_SELECTION_V1 }
              : {}),
            // The existing test-only route remains behind its packaged=false
            // launch gate. Production has exactly one selection, not a menu.
            ...(piE2eAdapter && options.runtimeRoutingPolicy ? { agentRoutingPolicy: options.runtimeRoutingPolicy } : {}),
          },
      baselineProvider,
      derivedBaselineProvider,
      workspaceBridge: inputStore.bridge,
      runtimePromptVault: inputStore,
      attemptRoleProvider: {
        readAttemptRoleBinding(attemptId) {
          const binding = codingRoleProfiles!.readAttemptBinding(attemptId)
          return binding ? runtimeCodingRoleBinding(binding) : null
        },
      },
      taskVerificationCoordinator,
      now: options.now,
    })

    codingPermissionModeModule = new CodingPermissionModeModuleV1({
      dbPath: hubDbPath,
      readSelectedMode: options.codingPermissionModeProvider ?? (() => 'CONFIRM_EACH'),
      readAttemptManifest: (attemptId) => attemptWorkspaces.manifest(attemptId),
      now: options.now,
    })
    codingPermissionModule = new CodingPermissionModuleV1({
      dbPath: hubDbPath,
      // The UI Adapter dismisses first; the Module's longer timeout remains a
      // fail-closed backstop for any future Adapter implementation.
      ui: new MainProcessCodingPermissionUIAdapterV1({ timeoutMs: 55_000 }),
      policy: codingPermissionModeModule,
      timeoutMs: 60_000,
      now: options.now,
    })
    codingAuthorizationModule = new CodingAuthorizationModuleV2({
      directUi: new MainProcessDirectCodingPermissionUIAdapterV3({
        timeoutMs: 55_000,
        windowProvider: (origin) => workerManager.resolveHostToolRequestWindow(origin),
      }),
      taskHub: codingPermissionModule,
    })
    codingAttemptPlanModule = new CodingAttemptPlanModuleV1({
      dbPath: hubDbPath,
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
      recoveryDatabaseWasAuthoritative,
      recoveryDatabaseIdentity,
      application,
      inputStage: {
        stageAttemptInput: (input) => inputStore!.stage(input),
        stageAttemptWorktreeInput: (input) => inputStore!.stageWorktree(input),
      },
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
      permissionModule: {
        decide: (intent) => codingAuthorizationModule!.decideTaskHub({
          subject: {
            schemaVersion: 2,
            kind: 'TASKHUB_ATTEMPT',
            attemptId: intent.attemptId,
          },
          intent,
        }),
      },
      permissionScope: attemptWorkspaces,
      attemptPlanGate: codingAttemptPlanModule,
      attemptRoleGate: {
        async isAttemptRoleExecutable(attemptId) {
          try {
            return codingRoleProfiles!.readAttemptBinding(attemptId) !== null
          } catch {
            return false
          }
        },
      },
      attemptPermissionModeGate: {
        captureSelection: () => codingPermissionModeModule!.captureSelection(),
        bindAttempt: (attemptId, selection) => (
          codingPermissionModeModule!.bindAttempt(attemptId, selection)
        ),
        verifyAttemptBinding: (attemptId, selection) => (
          codingPermissionModeModule!.verifyAttemptBinding(attemptId, selection)
        ),
      },
      now: options.now,
    })
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
      applyPortV2: new MainProcessChangeApplyPortV2({ projectResolver, registry: deliveryApplyRegistry }),
      now: options.now,
    })
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
      codingAuthorizationModule,
      codingPermissionModeModule,
      codingAttemptPlanModule,
      codingAttemptReviewModule,
      codingRoleProfiles,
      codingReviewStore,
      options.piE2eScriptedRuntimeLaunch,
      projectResolver,
      hubDbPath,
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
    closeQuietly(codingPermissionModeModule)
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
  codingAuthorizationModule: CodingAuthorizationModuleV2,
  codingPermissionModeModule: CodingPermissionModeModuleV1,
  codingAttemptPlanModule: CodingAttemptPlanModuleV1,
  codingAttemptReviewModule: CodingAttemptReviewModuleV1,
  codingRoleProfiles: CodingRoleProfileModuleV1,
  codingReviewStore: CollaborationHubSqliteStoreV1,
  piE2eLaunch: PiE2eScriptedRuntimeLaunchV1 | undefined,
  projectResolver: ProjectWorkspaceResolverV1,
  hubDbPath: string,
): XiaoguiRuntimeCompositionV1 {
  let closed = false
  let closePromise: Promise<void> | undefined
  const acceptAndExecuteTrustedPortV2 = createHubTaskAcceptAndExecuteTrustedPortV2({
    application, taskExecution, projectResolver,
    authorityDatabaseIdentity: () => databaseIdentity(hubDbPath),
  })

  return {
    application,
    taskExecution,
    delivery,
    codingPlan: codingAttemptPlanModule,
    codingReview: codingAttemptReviewModule,
    codingRoles: codingRoleProfiles,
    codingAuthorization: codingAuthorizationModule,
    acceptAndExecuteTrustedPortV2,
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
            codingPermissionModeModule,
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

/** Main-only adapter used by the Hub worker; callers opt in explicitly. */
export function createHubTaskAcceptAndExecuteTrustedPortV2(input: {
  readonly application: CollaborationHubApplicationV1
  readonly taskExecution: XiaoguiTaskExecutionOrchestratorV1
  readonly projectResolver: ProjectWorkspaceResolverV1
  readonly authorityDatabaseIdentity?: () => string | null
}): HubTaskAcceptAndExecuteTrustedPortV2 {
  const baselineProvider = new GitExecutionBaselineProviderV1(input.projectResolver)
  const resolveTarget = async (request: Parameters<HubTaskAcceptAndExecuteTrustedPortV2['resolveTarget']>[0]) => {
    const observed = await input.application.observeM2B(request.address)
    if (!observed.ok) return { ok: false as const, code: 'TARGET_PROJECT_INVALID' as const }
    let projectRoot: string
    try {
      projectRoot = await input.projectResolver.resolveProjectRoot(request.address.projectId)
    } catch {
      return { ok: false as const, code: 'TARGET_PROJECT_INVALID' as const }
    }
    let targetProjectIdentity: string
    try {
      targetProjectIdentity = projectWorktreeIdentityV2(request.address.projectId, projectRoot)
    } catch {
      return { ok: false as const, code: 'TARGET_PROJECT_INVALID' as const }
    }
    try {
      const baseline = await baselineProvider.capture({
        address: request.address,
        flowId: 'xhbf_accept_target_probe' as FlowId,
        planRevisionId: null,
      })
      const authorityDatabaseIdentity = input.authorityDatabaseIdentity?.()
      return {
        ok: true as const,
        targetProjectIdentity,
        baselineSourceDigest: `sha256:${baseline.baselineDigest}`,
        ...(authorityDatabaseIdentity ? { authorityDatabaseIdentity } : {}),
      }
    } catch {
      return { ok: false as const, code: 'BASELINE_SOURCE_INVALID' as const }
    }
  }
  const associationParts = (request: Parameters<HubTaskAcceptAndExecuteTrustedPortV2['execute']>[0]) => {
    const acceptanceKey = payloadDigest({
      version: 2, address: request.address, assignmentId: request.assignmentId,
      taskId: request.taskId, packageSha256: request.packageSha256, requestId: request.requestId,
    })
    const draftRequestId = `hub-accept-v2:${acceptanceKey}:draft`
    const activateRequestId = `hub-accept-v2:${acceptanceKey}:activate`
    const draftIntent = { type: 'flow.start.with_draft' as const, draft: request.draft }
    const baseAuthorization = {
      version: 2 as const, mode: 'ATTEMPT_WORKTREE' as const,
      projectId: request.address.projectId, sessionKey: request.address.sessionKey,
      acceptance: { requestId: request.requestId, assignmentId: request.assignmentId, taskId: request.taskId,
        taskContentDigest: request.packageSha256, targetProjectIdentity: request.targetProjectIdentity,
        baselineSourceDigest: request.baselineSourceDigest },
    }
    return { acceptanceKey, draftRequestId, activateRequestId, draftIntent,
      authorization: { ...baseAuthorization, authorizationDigest: attemptWorktreeAuthorizationDigestV2(baseAuthorization) } }
  }
  const recoverAssociation = async (request: Parameters<HubTaskAcceptAndExecuteTrustedPortV2['execute']>[0]) => {
    const parts = associationParts(request)
    const exact = input.taskExecution.recoverAcceptedWorktreeAssociationV2({
      address: request.address, draftRequestId: parts.draftRequestId, activateRequestId: parts.activateRequestId,
      expectedDraftCommandType: parts.draftIntent.type,
      expectedDraftPayloadHash: payloadDigest({ expectedSessionVersion: null, intent: parts.draftIntent }),
      expectedActivateCommandType: 'plan.revision.submit', prompt: '执行已由 Main 核验并冻结的当前任务正文与验收要求。',
      authorization: parts.authorization, draft: request.draft,
      requiresExistingAuthority: request.requiresExistingAuthority,
      authorityDatabaseIdentity: request.authorityDatabaseIdentity,
    })
    if (exact.status === 'ASSOCIATED') return { status: 'ASSOCIATED' as const, flowId: exact.flowId!, revisionId: exact.revisionId!, attemptId: exact.attemptId, attemptStatus: exact.attemptStatus, executionState: 'ASSOCIATION_RECOVERED' as const }
    if (exact.status === 'UNKNOWN') return { status: 'UNKNOWN' as const, flowId: exact.flowId, revisionId: exact.revisionId, attemptId: exact.attemptId, attemptStatus: exact.attemptStatus }
    if (exact.status === 'NOT_DISPATCHED') return { status: 'NOT_DISPATCHED' as const, flowId: exact.flowId, revisionId: exact.revisionId, attemptId: exact.attemptId, attemptStatus: exact.attemptStatus }
    return { status: 'UNRESOLVED' as const }
  }
  return {
    resolveTarget,
    recoverAssociation,
    async execute(request) {
      if (`sha256:${payloadDigest(request.draft)}` !== request.draftDigest) {
        return { ok: false, code: 'EXECUTION_NOT_STARTED' }
      }
      const target = await resolveTarget(request)
      if (!target.ok || target.targetProjectIdentity !== request.targetProjectIdentity) {
        return { ok: false, code: 'EXECUTION_NOT_STARTED' }
      }
      if (target.baselineSourceDigest !== request.baselineSourceDigest) {
        return { ok: false, code: 'EXECUTION_NOT_STARTED' }
      }
      const recovery = await recoverAssociation(request)
      if (recovery.status === 'ASSOCIATED') return { ok: true, flowId: recovery.flowId, revisionId: recovery.revisionId,
        attemptId: recovery.attemptId, attemptStatus: recovery.attemptStatus, executionState: recovery.executionState }
      if (recovery.status === 'UNKNOWN' || recovery.status === 'UNRESOLVED') return { ok: false, code: 'EXECUTION_OUTCOME_UNKNOWN' }
      const { acceptanceKey } = associationParts(request)
      const started = await input.application.perform(request.address, {
        requestId: `hub-accept-v2:${acceptanceKey}:draft`,
        intent: { type: 'flow.start.with_draft', draft: request.draft },
      })
      if (!started.ok || !started.value.flowId || !started.value.revisionId) {
        return { ok: false, code: 'EXECUTION_NOT_STARTED' }
      }
      const activated = await input.application.perform(request.address, {
        requestId: `hub-accept-v2:${acceptanceKey}:activate`,
        intent: {
          type: 'plan.revision.submit',
          flowId: started.value.flowId,
          baseRevisionId: started.value.revisionId,
          draft: request.draft,
        },
      })
      if (!activated.ok) return { ok: false, code: 'EXECUTION_NOT_STARTED' }
      const baseAuthorization = {
        version: 2 as const,
        mode: 'ATTEMPT_WORKTREE' as const,
        projectId: request.address.projectId,
        sessionKey: request.address.sessionKey,
        acceptance: {
          requestId: request.requestId,
          assignmentId: request.assignmentId,
          taskId: request.taskId,
          taskContentDigest: request.packageSha256,
          targetProjectIdentity: request.targetProjectIdentity,
          baselineSourceDigest: request.baselineSourceDigest,
        },
      }
      const finalRecovery = await recoverAssociation(request)
      if (finalRecovery.status === 'ASSOCIATED') {
        return { ok: true, flowId: finalRecovery.flowId, revisionId: finalRecovery.revisionId,
          attemptId: finalRecovery.attemptId, attemptStatus: finalRecovery.attemptStatus,
          executionState: finalRecovery.executionState }
      }
      if (finalRecovery.status !== 'NOT_DISPATCHED') return { ok: false, code: 'EXECUTION_OUTCOME_UNKNOWN' }
      const execution = await input.taskExecution.startAcceptedWorktreeV2({
        address: request.address,
        flowId: started.value.flowId,
        prompt: '执行已由 Main 核验并冻结的当前任务正文与验收要求。',
        authorization: {
          ...baseAuthorization,
          authorizationDigest: attemptWorktreeAuthorizationDigestV2(baseAuthorization),
        },
      })
      if (!execution.ok) {
        return { ok: false, code: execution.error.code === 'OUTCOME_UNKNOWN'
          ? 'EXECUTION_OUTCOME_UNKNOWN'
          : 'EXECUTION_NOT_STARTED' }
      }
      const status = execution.value.attempt.status
      if (['SUCCEEDED', 'FAILED', 'INTERRUPTED', 'CANCELLED', 'OUTCOME_UNKNOWN'].includes(status)) {
        return { ok: false, code: status === 'OUTCOME_UNKNOWN'
          ? 'EXECUTION_OUTCOME_UNKNOWN'
          : 'EXECUTION_ALREADY_SETTLED' }
      }
      return {
        ok: true,
        flowId: started.value.flowId,
        revisionId: started.value.revisionId,
        attemptId: execution.value.attempt.attemptId,
        executionState: ['STARTING', 'RUNNING', 'VERIFYING'].includes(status) ? 'STARTED' : 'PREPARED',
      }
    },
  }
}

function databaseIdentity(dbPath: string): string | null {
  try {
    const stat = statSync(dbPath, { bigint: true })
    return `xhdb_${createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest('hex')}`
  } catch { return null }
}

export function createMainAttemptWorkspaceBaselineSourceResolverV1(
  hubDbPath: string,
  inputStoreProvider: () => AttemptExecutionInputStoreV1 | undefined,
): AttemptWorkspaceBaselineSourceResolverV1 {
  return {
    resolve({ request, grants }) {
      const inputStore = inputStoreProvider()
      if (!inputStore) return null
      let staged: ResolvedAttemptExecutionInput
      try {
        staged = inputStore.resolve(request.attemptId)
      } catch {
        return null
      }
      const store = new CollaborationHubSqliteStoreV1(hubDbPath)
      try {
        return resolveMainAttemptWorkspaceBaselineSourceV1(store, request, grants, staged)
      } finally {
        store.close()
      }
    },
  }
}

function resolveMainAttemptWorkspaceBaselineSourceV1(
  store: CollaborationHubSqliteStoreV1,
  request: Parameters<AttemptWorkspaceBaselineSourceResolverV1['resolve']>[0]['request'],
  grants: readonly AttemptFileGrantV1[],
  staged: ResolvedAttemptExecutionInput,
): AttemptWorkspaceBaselineSourceBindingV1 | null {
  const attemptId = String(request.attemptId)
  const attempt = store.attemptExecutionScope(attemptId as AttemptId)
  const composition = store.compositionAttempt(attemptId as AttemptId)
  const task = store.taskExecutionBaseline(attemptId as AttemptId)
  if (!attempt || !composition || !task) return null
  const worktreeRequest = isAttemptWorkspacePrepareRequestV2(request) ? request : null
  const worktreeStaged = staged.inputVersion === 2 ? staged : null
  if ((worktreeRequest === null) !== (worktreeStaged === null)) return null
  if (worktreeRequest && worktreeStaged && (
    worktreeRequest.authorization.authorizationDigest !== worktreeStaged.authorization.authorizationDigest ||
    JSON.stringify(worktreeRequest.authorization) !== JSON.stringify(worktreeStaged.authorization)
  )) return null
  if (
    attempt.attempt_id !== attemptId ||
    attempt.project_id !== staged.projectId ||
    attempt.session_key !== staged.sessionKey ||
    staged.attemptId !== attemptId ||
    staged.projectId !== request.projectId ||
    (!worktreeStaged && staged.grants.length !== grants.length) ||
    (!worktreeStaged && JSON.stringify(staged.grants) !== JSON.stringify(grants)) ||
    composition.attemptId !== attemptId ||
    composition.compositionAttemptId !== request.compositionAttemptId ||
    composition.requestDigest !== request.requestDigest ||
    composition.baselineBindingDigest !== request.baselineBindingDigest ||
    composition.compositionDigest !== request.compositionDigest ||
    task.attempt_id !== attemptId ||
    task.task_run_id !== attempt.task_run_id ||
    task.flow_id !== attempt.flow_id ||
    task.baseline_binding_digest !== request.baselineBindingDigest ||
    task.base_revision !== request.baseRevision ||
    task.baseline_tree_hash !== request.baselineTreeHash ||
    (!worktreeStaged && workspaceDigestJson(grants) !== workspaceDigestJson(staged.grants))
  ) {
    return null
  }

  const flow = store.flowExecutionBaseline(attempt.flow_id as FlowId)
  if (!flow || flow.flow_id !== attempt.flow_id) return null
  const sourceBaseline = sourceBaselineFromRecord(flow)
  if (!sourceBaseline || sourceBaseline.baselineBindingDigest !== flow.baseline_binding_digest) return null
  if (
    worktreeStaged &&
    worktreeStaged.authorization.acceptance.baselineSourceDigest !== `sha256:${sourceBaseline.baselineDigest}`
  ) return null
  if (
    flow.baseline_digest !== payloadDigest({
      baselineId: sourceBaseline.baselineId,
      ...(sourceBaseline.baseRevision ? { baseRevision: sourceBaseline.baseRevision } : {}),
      baselineTreeHash: sourceBaseline.baselineTreeHash,
      initialTargetFingerprint: sourceBaseline.initialTargetFingerprint,
    }) ||
    flow.baseline_binding_digest !== payloadDigest({
      flowId: attempt.flow_id,
      baseline: {
        baselineId: sourceBaseline.baselineId,
        ...(sourceBaseline.baseRevision ? { baseRevision: sourceBaseline.baseRevision } : {}),
        baselineTreeHash: sourceBaseline.baselineTreeHash,
        initialTargetFingerprint: sourceBaseline.initialTargetFingerprint,
        baselineDigest: sourceBaseline.baselineDigest,
      },
    })
  ) {
    return null
  }

  const ancestors = parseStringArray(task.ancestor_task_change_set_ids_json)
  if (!ancestors || JSON.stringify(ancestors) !== task.ancestor_task_change_set_ids_json) return null
  const taskBaseline = taskBaselineFromRecord(task, ancestors)
  if (!taskBaseline) return null
  if (
    task.baseline_binding_digest !== payloadDigest({
      version: 1,
      flowId: attempt.flow_id,
      taskRunId: attempt.task_run_id,
      taskBaseline: taskBaselinePayload(taskBaseline, attempt.task_run_id),
    })
  ) {
    return null
  }

  const common = {
    version: 1 as const,
    attemptId,
    projectId: staged.projectId,
    sessionKey: staged.sessionKey,
    flowId: attempt.flow_id,
    taskRunId: attempt.task_run_id,
    source: sourceBaseline,
    task: taskBaseline,
    grantsDigest: workspaceDigestJson(grants),
  }
  if (ancestors.length === 0) {
    const expectedTaskDerivation = payloadDigest({
      version: 1,
      taskRunId: attempt.task_run_id,
      ancestorTaskChangeSetIds: [],
      baselineId: sourceBaseline.baselineId,
      ...(sourceBaseline.baseRevision ? { baseRevision: sourceBaseline.baseRevision } : {}),
      baselineTreeHash: sourceBaseline.baselineTreeHash,
      initialTargetFingerprint: sourceBaseline.initialTargetFingerprint,
      baselineDigest: sourceBaseline.baselineDigest,
    })
    if (
      taskBaseline.derivationDigest !== expectedTaskDerivation ||
      !sameBaselineFields(sourceBaseline, taskBaseline)
    ) {
      return null
    }
    return withSourceBindingDigest({ ...common, kind: 'PROJECT' })
  }

  const derivationInputDigest = derivedInputDigest(
    store,
    staged,
    attempt.flow_id,
    attempt.task_run_id,
    sourceBaseline,
    ancestors,
  )
  if (!derivationInputDigest) return null
  const cache = store.derivedExecutionBaseline(derivationInputDigest)
  if (!cache || cache.project_id !== staged.projectId || cache.flow_id !== attempt.flow_id || cache.task_run_id !== attempt.task_run_id) {
    return null
  }
  const cachedBaseline = parseCanonicalDerivedBaseline(
    cache.baseline_json,
    attempt.task_run_id,
    ancestors,
  )
  if (
    !cachedBaseline ||
    !sameBaselineFields(cachedBaseline, taskBaseline) ||
    cachedBaseline.initialTargetFingerprint !== sourceBaseline.initialTargetFingerprint ||
    cachedBaseline.derivationDigest !== taskBaseline.derivationDigest ||
    taskBaseline.baselineBindingDigest !== payloadDigest({
      version: 1,
      flowId: attempt.flow_id,
      taskRunId: attempt.task_run_id,
      taskBaseline: taskBaselinePayload(cachedBaseline, attempt.task_run_id),
    })
  ) {
    return null
  }
  return withSourceBindingDigest({
    ...common,
    kind: 'DERIVED',
    derivation: {
      derivationInputDigest,
      cacheDigest: workspaceDigestBytes(Buffer.from(cache.baseline_json, 'utf8')),
    },
  })
}

function isAttemptWorkspacePrepareRequestV2(
  request: Parameters<AttemptWorkspaceBaselineSourceResolverV1['resolve']>[0]['request'],
): request is AttemptWorkspacePrepareRequestV2 {
  return 'authorization' in request && request.authorization?.version === 2 &&
    request.authorization.mode === 'ATTEMPT_WORKTREE'
}

function sourceBaselineFromRecord(
  record: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['flowExecutionBaseline']>>,
): AttemptWorkspaceBaselineSourceBindingV1['source'] | null {
  if (
    typeof record.baseline_id !== 'string' ||
    typeof record.base_revision !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(record.base_revision) ||
    typeof record.baseline_tree_hash !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(record.baseline_tree_hash) ||
    typeof record.initial_target_fingerprint !== 'string' ||
    typeof record.baseline_digest !== 'string' ||
    typeof record.baseline_binding_digest !== 'string'
  ) return null
  return {
    baselineId: record.baseline_id,
    baseRevision: record.base_revision,
    baselineTreeHash: record.baseline_tree_hash,
    initialTargetFingerprint: record.initial_target_fingerprint,
    baselineDigest: record.baseline_digest,
    baselineBindingDigest: record.baseline_binding_digest,
  }
}

function taskBaselineFromRecord(
  record: NonNullable<ReturnType<CollaborationHubSqliteStoreV1['taskExecutionBaseline']>>,
  ancestors: readonly string[],
): AttemptWorkspaceBaselineSourceBindingV1['task'] | null {
  if (
    typeof record.baseline_id !== 'string' ||
    typeof record.base_revision !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(record.base_revision) ||
    typeof record.baseline_tree_hash !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(record.baseline_tree_hash) ||
    typeof record.initial_target_fingerprint !== 'string' ||
    typeof record.baseline_digest !== 'string' ||
    typeof record.baseline_binding_digest !== 'string' ||
    typeof record.derivation_digest !== 'string'
  ) return null
  return {
    baselineId: record.baseline_id,
    baseRevision: record.base_revision,
    baselineTreeHash: record.baseline_tree_hash,
    initialTargetFingerprint: record.initial_target_fingerprint,
    baselineDigest: record.baseline_digest,
    baselineBindingDigest: record.baseline_binding_digest,
    derivationDigest: record.derivation_digest,
    ancestorTaskChangeSetIds: [...ancestors],
  }
}

function sameBaselineFields(
  left: Pick<AttemptWorkspaceBaselineSourceBindingV1['task'], 'baselineId' | 'baseRevision' | 'baselineTreeHash' | 'initialTargetFingerprint' | 'baselineDigest'>,
  right: Pick<AttemptWorkspaceBaselineSourceBindingV1['task'], 'baselineId' | 'baseRevision' | 'baselineTreeHash' | 'initialTargetFingerprint' | 'baselineDigest'>,
): boolean {
  return left.baselineId === right.baselineId &&
    left.baseRevision === right.baseRevision &&
    left.baselineTreeHash === right.baselineTreeHash &&
    left.initialTargetFingerprint === right.initialTargetFingerprint &&
    left.baselineDigest === right.baselineDigest
}

function taskBaselinePayload(
  task: AttemptWorkspaceBaselineSourceBindingV1['task'],
  taskRunId: string,
): Record<string, unknown> {
  return {
    version: 1,
    taskRunId,
    ancestorTaskChangeSetIds: task.ancestorTaskChangeSetIds,
    baselineId: task.baselineId,
    baseRevision: task.baseRevision,
    baselineTreeHash: task.baselineTreeHash,
    initialTargetFingerprint: task.initialTargetFingerprint,
    baselineDigest: task.baselineDigest,
    derivationDigest: task.derivationDigest,
  }
}

function parseStringArray(value: string): readonly string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string') || new Set(parsed).size !== parsed.length) return null
    return parsed
  } catch {
    return null
  }
}

function derivedInputDigest(
  store: CollaborationHubSqliteStoreV1,
  staged: ResolvedAttemptExecutionInput,
  flowId: string,
  taskRunId: string,
  flowBaseline: AttemptWorkspaceBaselineSourceBindingV1['source'],
  ancestors: readonly string[],
): string | null {
  const taskChangeSets = []
  for (const id of ancestors) {
    const changeSet = store.readTaskChangeSet(id as TaskChangeSetId)
    if (!changeSet || changeSet.flowId !== flowId || changeSet.taskChangeSetId !== id) return null
    if (
      taskChangeSetDigestV1({
        inputTreeHash: changeSet.inputTreeHash,
        resultTreeHash: changeSet.resultTreeHash,
        ancestorTaskChangeSetIds: changeSet.ancestorTaskChangeSetIds,
        patchArtifactId: changeSet.patchArtifactId,
      }) !== changeSet.digest
    ) return null
    const artifact = store.readArtifact(changeSet.patchArtifactId as ArtifactId)
    if (
      !artifact ||
      artifact.kind !== 'PATCH' ||
      artifact.artifactId !== changeSet.patchArtifactId ||
      workspaceDigestBytes(artifact.content) !== artifact.contentDigest
    ) return null
    taskChangeSets.push({
      taskChangeSetId: changeSet.taskChangeSetId,
      digest: changeSet.digest,
      patchArtifactId: artifact.artifactId,
      patchArtifactDigest: artifact.contentDigest,
    })
  }
  return payloadDigest({
    version: 1,
    address: { projectId: staged.projectId, sessionKey: staged.sessionKey },
    flowId,
    taskRunId,
    flowBaseline: {
      baselineId: flowBaseline.baselineId,
      baseRevision: flowBaseline.baseRevision,
      baselineTreeHash: flowBaseline.baselineTreeHash,
      initialTargetFingerprint: flowBaseline.initialTargetFingerprint,
      baselineDigest: flowBaseline.baselineDigest,
    },
    dependencyOrder: ancestors,
    taskChangeSets,
  })
}

function parseCanonicalDerivedBaseline(
  value: string,
  taskRunId: string,
  ancestors: readonly string[],
): (AttemptWorkspaceBaselineSourceBindingV1['task'] & { readonly version: 1; readonly taskRunId: string }) | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const expectedKeys = [
      'version',
      'taskRunId',
      'ancestorTaskChangeSetIds',
      'baselineId',
      'baseRevision',
      'baselineTreeHash',
      'initialTargetFingerprint',
      'baselineDigest',
      'derivationDigest',
    ].sort()
    if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys)) return null
    if (
      parsed.version !== 1 ||
      parsed.taskRunId !== taskRunId ||
      !Array.isArray(parsed.ancestorTaskChangeSetIds) ||
      JSON.stringify(parsed.ancestorTaskChangeSetIds) !== JSON.stringify(ancestors) ||
      typeof parsed.baselineId !== 'string' ||
      typeof parsed.baseRevision !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(parsed.baseRevision) ||
      typeof parsed.baselineTreeHash !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(parsed.baselineTreeHash) ||
      typeof parsed.initialTargetFingerprint !== 'string' ||
      typeof parsed.baselineDigest !== 'string' ||
      typeof parsed.derivationDigest !== 'string' ||
      JSON.stringify(parsed) !== value
    ) return null
    const expectedBaselineDigest = payloadDigest({
      baselineId: parsed.baselineId,
      baseRevision: parsed.baseRevision,
      baselineTreeHash: parsed.baselineTreeHash,
      initialTargetFingerprint: parsed.initialTargetFingerprint,
    })
    const { derivationDigest: _ignored, ...withoutDerivation } = parsed
    if (parsed.baselineDigest !== expectedBaselineDigest || parsed.derivationDigest !== payloadDigest(withoutDerivation)) return null
    return {
      version: 1,
      taskRunId,
      ancestorTaskChangeSetIds: ancestors,
      baselineId: parsed.baselineId,
      baseRevision: parsed.baseRevision,
      baselineTreeHash: parsed.baselineTreeHash,
      initialTargetFingerprint: parsed.initialTargetFingerprint,
      baselineDigest: parsed.baselineDigest,
      baselineBindingDigest: '',
      derivationDigest: parsed.derivationDigest,
    }
  } catch {
    return null
  }
}

function withSourceBindingDigest(
  source: Omit<AttemptWorkspaceBaselineSourceBindingV1, 'bindingDigest'>,
): AttemptWorkspaceBaselineSourceBindingV1 {
  return {
    ...source,
    bindingDigest: workspaceDigestJson(source),
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
