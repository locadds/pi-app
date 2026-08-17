import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { RuntimeAdapterSelectionV1 } from '@shared/xiaogui-agent-runtime'
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
import { PrivateRuntimePayloadVaultV1 } from './private-payload-vault'
import { MainProjectWorkspaceResolverV1 } from './project-workspace-resolver'
import { CollaborationHubSqliteStoreV1 } from './sqlite-store'
import { XiaoguiTaskExecutionOrchestratorV1 } from './execution-orchestrator'

export interface XiaoguiRuntimeCompositionOptionsV1 {
  readonly userDataDir: string
  readonly productionEnabled: boolean
  readonly lookup: SessionScopeLookupV1
  readonly projectResolver?: ProjectWorkspaceResolverV1
  readonly kimiProbe?: KimiAcpProbeV1
  readonly kimiTransportFactory?: AcpTransportFactoryV1
  readonly now?: () => string
}

/**
 * Main-process-only deep Module for the Task Hub execution path. Callers stage
 * private inputs at this seam, then drive the public application Interface.
 */
export interface XiaoguiRuntimeCompositionV1 {
  readonly application: CollaborationHubApplicationV1
  readonly taskExecution: XiaoguiTaskExecutionOrchestratorV1
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
  mkdirSync(taskHubDir, { recursive: true })

  let workspaceRegistry: SqliteAttemptWorkspaceRegistryV1 | undefined
  let payloadVault: PrivateRuntimePayloadVaultV1 | undefined
  let inputStore: AttemptExecutionInputStoreV1 | undefined
  let application: CollaborationHubApplicationV1 | undefined
  let kimiAdapter: KimiAcpRuntimeAdapterV1 | undefined
  let taskExecution: XiaoguiTaskExecutionOrchestratorV1 | undefined

  try {
    const projectResolver = options.projectResolver ?? new MainProjectWorkspaceResolverV1()
    const baselineProvider = new GitExecutionBaselineProviderV1(projectResolver)
    workspaceRegistry = new SqliteAttemptWorkspaceRegistryV1({
      dbPath: join(taskHubDir, 'attempt-workspaces.sqlite'),
    })
    const attemptWorkspaces = new GitAttemptWorkspaceServiceV1(workspaceRegistry, projectResolver, {
      managedRoot: join(xiaoguiDir, 'attempt-worktrees'),
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
    const runtimeHost = createAgentRuntimeHostV1(kimiAdapter)

    const hubDbPath = join(userDataDir, 'xiaogui-task-hub-m2a.sqlite')
    application = createCollaborationHubApplicationV1({
      lookup: options.lookup,
      // Keep the existing desktop database location so installing the runtime
      // composition does not make previously created plans disappear.
      storeFactory: () => new CollaborationHubSqliteStoreV1(hubDbPath),
      ...(options.productionEnabled
        ? { agentRuntime: runtimeHost, agentSelection: KIMI_PRODUCTION_SELECTION_V1 }
        : {}),
      baselineProvider,
      workspaceBridge: inputStore.bridge,
      runtimePromptVault: inputStore,
      now: options.now,
    })

    taskExecution = new XiaoguiTaskExecutionOrchestratorV1({
      dbPath: hubDbPath,
      application,
      inputStage: { stageAttemptInput: (input) => inputStore!.stage(input) },
      fileScopeResolver: attemptWorkspaces,
      now: options.now,
    })
    void taskExecution.recover().catch(() => undefined)

    return createCompositionInterface(
      application,
      taskExecution,
      kimiAdapter,
      inputStore,
      payloadVault,
      workspaceRegistry,
    )
  } catch (error) {
    closeQuietly(taskExecution)
    closeQuietly(kimiAdapter)
    closeQuietly(application)
    closeQuietly(inputStore)
    closeQuietly(payloadVault)
    closeQuietly(workspaceRegistry)
    throw error
  }
}

function createCompositionInterface(
  application: CollaborationHubApplicationV1,
  taskExecution: XiaoguiTaskExecutionOrchestratorV1,
  kimiAdapter: KimiAcpRuntimeAdapterV1,
  inputStore: AttemptExecutionInputStoreV1,
  payloadVault: PrivateRuntimePayloadVaultV1,
  workspaceRegistry: SqliteAttemptWorkspaceRegistryV1,
): XiaoguiRuntimeCompositionV1 {
  let closed = false
  let closePromise: Promise<void> | undefined

  return {
    application,
    taskExecution,
    stageAttemptInput(input) {
      if (closed) throw new Error('XIAOGUI_RUNTIME_COMPOSITION_CLOSED')
      return inputStore.stage(input)
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      closePromise = taskExecution.close().then(() => closeAll([
          kimiAdapter,
          application,
          inputStore,
          payloadVault,
          workspaceRegistry,
        ]))
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
