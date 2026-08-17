import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'

import { app } from 'electron'
import { z } from 'zod'

import type {
  HubAddressV1,
  M2ADisabledIntentTypeV1,
  HubObserveIpcRequestV1,
  HubPerformIpcRequestV1,
  HubReadEventsIpcRequestV1,
  HubReadIpcRequestV1,
} from '@shared/xiaogui-collaboration-hub'
import type { XiaoguiDeliveryCoordinatorPortV1 } from '@shared/xiaogui-delivery-ipc'
import type { XiaoguiTaskExecutionStartRequestV1 } from '@shared/xiaogui-task-execution'
import { configStore } from '../../config-store'
import { registerHandler } from '../../ipc/registry'
import { KimiLoginCoordinatorV1 } from '../agent-runtime/kimi-login'
import { sessionScopeResolverV1 } from '../scope-service'
import type { CollaborationHubApplicationV1 } from './application'
import { hubError } from './errors'
import { XiaoguiTaskExecutionOrchestratorV1 } from './execution-orchestrator'
import {
  createXiaoguiRuntimeCompositionV1,
  type XiaoguiRuntimeCompositionV1,
} from './runtime-composition'
import { registerXiaoguiDeliveryHandlers } from './delivery-ipc'

const AddressSchema = z
  .object({
    projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
    sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
  })
  .strict()

const TaskSchema = z
  .object({
    taskKey: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
  })
  .strict()

const DraftSchema = z
  .object({
    objective: z.string().min(1),
    tasks: z.array(TaskSchema),
  })
  .strict()

const EnabledIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('flow.start.with_draft'), draft: DraftSchema, sourceTurnId: z.string().optional() }).strict(),
  z
    .object({
      type: z.literal('plan.revision.submit'),
      flowId: z.string().min(1),
      baseRevisionId: z.string().min(1),
      draft: DraftSchema,
    })
    .strict(),
  z.object({ type: z.literal('flow.cancel'), flowId: z.string().min(1), reason: z.string().min(1) }).strict(),
])

const DisabledIntentTypes = [
  'flow.start',
  'agent.revision.proposal.record',
  'task.run.guide',
  'task.run.cancel',
  'attempt.interrupt',
  'delivery.selection.submit',
  'gate.decide',
  'apply.reconcile.request',
  'apply.retry.request',
  'correction.create',
  'system.schedule',
  'system.workspace.prepare.result.record',
  'system.agent.report.record',
  'system.agent.outcome.record',
  'system.agent.reconcile',
  'system.verification.complete',
  'system.verification.reconcile',
] as const satisfies readonly M2ADisabledIntentTypeV1[]

// Later-slice payloads remain opaque in M2A. We only recognise their stable
// discriminator so the application can fail closed with INTENT_DISABLED.
const DisabledIntentSchema = z.object({ type: z.enum(DisabledIntentTypes) }).passthrough()
const IntentSchema = z.union([EnabledIntentSchema, DisabledIntentSchema])

const VersionSchema = z.object({ contractVersion: z.string().optional() })
const ObserveSchema = VersionSchema.extend({ address: AddressSchema }).strict()
const PerformSchema = z
  .object({
    contractVersion: z.string().optional(),
    address: AddressSchema,
    request: z
      .object({ requestId: z.string().min(1), expectedSessionVersion: z.number().int().nonnegative().optional(), intent: IntentSchema })
      .strict(),
  })
  .strict()
const ReadSchema = z
  .object({
    contractVersion: z.string().optional(),
    address: AddressSchema,
    request: z.discriminatedUnion('type', [
      z.object({ type: z.literal('session.current') }).strict(),
      z.object({ type: z.literal('flow.by_id'), flowId: z.string().min(1) }).strict(),
    ]),
  })
  .strict()
const ReadEventsSchema = z
  .object({
    contractVersion: z.string().optional(),
    address: AddressSchema,
    request: z.object({ afterSessionSequence: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).strict().optional(),
  })
  .strict()

const ExecutionFileSchema = z
  .object({
    operation: z.enum(['MODIFY', 'CREATE']),
    relativePath: z.string().min(1).max(1024).refine(isSafeExecutionRelativePath),
  })
  .strict()
const ExecutionStartSchema = z
  .object({
    address: AddressSchema,
    flowId: z.string().min(1).max(256).refine((value) => value === value.trim()),
    prompt: z
      .string()
      .refine((value) => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 1024 * 1024),
    files: z.array(ExecutionFileSchema).min(1).max(256),
  })
  .strict()

interface DefaultRuntimeLifecycleV1 {
  readonly composition: XiaoguiRuntimeCompositionV1
  readonly kimiLogin: KimiLoginCoordinatorV1
}

let defaultRuntimeLifecycle: DefaultRuntimeLifecycleV1 | null = null

export function getDefaultCollaborationHubApplication(): CollaborationHubApplicationV1 {
  return getDefaultRuntimeLifecycle().composition.application
}

export function getDefaultKimiLoginCoordinator(): KimiLoginCoordinatorV1 {
  return getDefaultRuntimeLifecycle().kimiLogin
}

export function getDefaultTaskExecutionOrchestrator(): XiaoguiTaskExecutionOrchestratorV1 {
  return getDefaultRuntimeLifecycle().composition.taskExecution
}

export function getDefaultDeliveryCoordinator(): XiaoguiDeliveryCoordinatorPortV1 {
  return getDefaultRuntimeLifecycle().composition.delivery
}

export async function closeDefaultCollaborationHubRuntimeComposition(): Promise<void> {
  const lifecycle = defaultRuntimeLifecycle
  defaultRuntimeLifecycle = null
  lifecycle?.kimiLogin.close()
  await lifecycle?.composition.close()
}

export function registerCollaborationHubHandlers(
  application = getDefaultCollaborationHubApplication(),
  kimiLogin?: KimiLoginCoordinatorV1,
  taskExecution?: XiaoguiTaskExecutionOrchestratorV1,
  deliveryCoordinator?: XiaoguiDeliveryCoordinatorPortV1,
): void {
  const resolveKimiLogin = () => kimiLogin ?? getDefaultKimiLoginCoordinator()
  const resolveTaskExecution = () => taskExecution ?? getDefaultTaskExecutionOrchestrator()
  if (deliveryCoordinator) {
    registerXiaoguiDeliveryHandlers(deliveryCoordinator)
  } else if (arguments.length === 0) {
    registerXiaoguiDeliveryHandlers(getDefaultDeliveryCoordinator())
  }

  registerHandler('ipc:xiaogui.hub.observe', async (payload) => {
    const parsed = parseIpc(ObserveSchema, payload)
    if (!parsed.ok) return parsed
    const version = rejectUnsupportedHubContractVersion(parsed.value.contractVersion, ['m2a.v1', 'm2b.v1'])
    if (version) return version
    const typed = parsed.value as HubObserveIpcRequestV1
    return typed.contractVersion === 'm2b.v1'
      ? application.observeM2B(typed.address)
      : application.observe(typed.address)
  })
  registerHandler('ipc:xiaogui.hub.execution.start', async (payload) => {
    const parsed = ExecutionStartSchema.safeParse(payload)
    if (!parsed.success) return invalidExecutionInput()
    return resolveTaskExecution().start(parsed.data as unknown as XiaoguiTaskExecutionStartRequestV1)
  })
  registerHandler('ipc:xiaogui.hub.perform', async (payload) => {
    const parsed = parseIpc(PerformSchema, payload)
    if (!parsed.ok) return parsed
    const version = rejectUnsupportedHubContractVersion(parsed.value.contractVersion)
    if (version) return version
    const typed = parsed.value as HubPerformIpcRequestV1
    return application.execute({
      ...typed.request,
      contractVersion: 'm2a.v1',
      address: typed.address,
      trustedActor: { kind: 'main-process-user' },
    })
  })
  registerHandler('ipc:xiaogui.hub.read', async (payload) => {
    const parsed = parseIpc(ReadSchema, payload)
    if (!parsed.ok) return parsed
    const version = rejectUnsupportedHubContractVersion(parsed.value.contractVersion)
    if (version) return version
    const typed = parsed.value as HubReadIpcRequestV1
    return application.read(typed.address, typed.request)
  })
  registerHandler('ipc:xiaogui.hub.readEvents', async (payload) => {
    const parsed = parseIpc(ReadEventsSchema, payload)
    if (!parsed.ok) return parsed
    const version = rejectUnsupportedHubContractVersion(parsed.value.contractVersion)
    if (version) return version
    const typed = parsed.value as HubReadEventsIpcRequestV1
    return application.readEvents(typed.address, typed.request)
  })
  registerHandler('ipc:xiaogui.kimi.status', async (payload) => {
    assertEmptyKimiIpcPayload(payload)
    return resolveKimiLogin().inspect()
  })
  registerHandler('ipc:xiaogui.kimi.login.start', async (payload) => {
    assertEmptyKimiIpcPayload(payload)
    return resolveKimiLogin().startLogin()
  })
}

function getDefaultRuntimeLifecycle(): DefaultRuntimeLifecycleV1 {
  if (defaultRuntimeLifecycle) return defaultRuntimeLifecycle

  const userDataDir = app.getPath('userData')
  const effectiveEnabled = configStore.get('xiaoguiKimiProductionEnabled') === true
  const composition = createXiaoguiRuntimeCompositionV1({
    userDataDir,
    productionEnabled: effectiveEnabled,
    lookup: sessionScopeResolverV1,
  })
  defaultRuntimeLifecycle = {
    composition,
    kimiLogin: new KimiLoginCoordinatorV1({
      effectiveEnabled,
      userDataDir,
    }),
  }
  return defaultRuntimeLifecycle
}

function assertEmptyKimiIpcPayload(payload: unknown): asserts payload is Record<string, never> {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 0
  ) {
    throw new Error('XIAOGUI_KIMI_IPC_PARAMETERS_NOT_ALLOWED')
  }
}

function isSafeExecutionRelativePath(value: string): boolean {
  if (
    value !== value.trim() ||
    value.includes('\0') ||
    value.includes(':') ||
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  ) return false
  const parts = value.replace(/[\\]+/g, '/').split('/')
  return !parts.some(
    (part) => part.length === 0 || part === '.' || part === '..' || part.toLowerCase() === '.git',
  )
}

function invalidExecutionInput() {
  return {
    ok: false as const,
    error: {
      code: 'EXECUTION_INPUT_INVALID' as const,
      messageKey: 'xiaogui.hub.execution.execution_input_invalid',
      traceId: `xhbet_${randomUUID()}`,
    },
  }
}

export function rejectUnsupportedHubContractVersion(
  contractVersion?: string,
  supportedVersions: readonly string[] = ['m2a.v1'],
) {
  return contractVersion && supportedVersions.includes(contractVersion)
    ? null
    : hubError('IPC_VERSION_UNSUPPORTED')
}

function parseIpc<T>(schema: z.ZodSchema<T>, payload: unknown) {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) return hubError('INTERNAL')
  return { ok: true as const, value: parsed.data }
}
