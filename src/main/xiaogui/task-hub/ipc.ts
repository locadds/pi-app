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
import { registerHandler } from '../../ipc/registry'
import { sessionScopeResolverV1 } from '../scope-service'
import type { CollaborationHubApplicationV1 } from './application'
import { hubError } from './errors'
import {
  createXiaoguiRuntimeCompositionV1,
  type XiaoguiRuntimeCompositionV1,
} from './runtime-composition'

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

let defaultRuntimeComposition: XiaoguiRuntimeCompositionV1 | null = null

export function getDefaultCollaborationHubApplication(): CollaborationHubApplicationV1 {
  defaultRuntimeComposition ??= createXiaoguiRuntimeCompositionV1({
    userDataDir: app.getPath('userData'),
    productionEnabled: false,
    lookup: sessionScopeResolverV1,
  })
  return defaultRuntimeComposition.application
}

export async function closeDefaultCollaborationHubRuntimeComposition(): Promise<void> {
  const composition = defaultRuntimeComposition
  defaultRuntimeComposition = null
  await composition?.close()
}

export function registerCollaborationHubHandlers(application = getDefaultCollaborationHubApplication()): void {
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
