import { z } from 'zod'

import {
  XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
  type CodingRoleAgentSnapshotV1,
  type CodingRoleAttemptOutcomeV1,
  type CodingRoleCopyOutcomeV1,
  type CodingRoleControlErrorCodeV1,
  type CodingRoleListOutcomeV1,
  type CodingRoleReadForEditOutcomeV1,
  type CodingRoleResetDefaultOutcomeV1,
  type CodingRoleUpsertOutcomeV1,
} from '@shared/xiaogui-coding-role-control'
import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'

import { registerHandler } from '../../ipc/registry'
import type {
  CodingAttemptRoleBindingV1,
  CodingResolvedRoleProfileV1,
  CodingRoleProfileDraftV1,
  CodingRoleProfileModuleV1,
} from './role-profile-module'

const AddressSchema = z.object({
  projectId: z.string().regex(/^xgp1_[0-9a-f]{64}$/),
  sessionKey: z.string().regex(/^xgs1_[0-9a-f]{64}$/),
}).strict()
const SafeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/i)
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const BaseFields = {
  contractVersion: z.literal(XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1),
  address: AddressSchema,
}
const ListSchema = z.object(BaseFields).strict()
const ReadForEditSchema = z.object({ ...BaseFields, profileId: SafeIdSchema }).strict()
const UpsertSchema = z.object({
  ...BaseFields,
  profile: z.object({
    schemaVersion: z.literal(1),
    profileId: SafeIdSchema,
    role: z.enum(['RESEARCH', 'IMPLEMENT', 'REVIEW']),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    systemPrompt: z.string().trim().min(1).max(20_000),
    modelSelector: z.string().min(1).max(128),
    runtimePolicyId: z.string().min(1).max(128),
    toolAllowlist: z.array(z.string()).max(8),
  }).strict(),
}).strict()
const CopySchema = z.object({
  ...BaseFields,
  sourceProfileId: SafeIdSchema,
  newProfileId: SafeIdSchema,
}).strict()
const ResetDefaultSchema = z.object({ ...BaseFields, profileId: SafeIdSchema }).strict()
const AttemptBindSchema = z.object({
  ...BaseFields,
  attemptId: SafeIdSchema,
  profileId: SafeIdSchema,
  expectedProfileDigest: DigestSchema,
}).strict()
const AttemptReadSchema = z.object({ ...BaseFields, attemptId: SafeIdSchema }).strict()

type RolePortV1 = Pick<
  CodingRoleProfileModuleV1,
  | 'list'
  | 'readForEdit'
  | 'upsert'
  | 'copy'
  | 'resetDefault'
  | 'resolve'
  | 'bindAttempt'
  | 'readAttemptBinding'
>

export interface CodingRoleScopePortV1 {
  isCodingSession(address: HubAddressV1): boolean | Promise<boolean>
  hasAttempt(address: HubAddressV1, attemptId: string): boolean | Promise<boolean>
}

/** Main-only activation port. Implementations may route to a Pi Worker but never Renderer. */
export interface CodingRoleRuntimePortV1 {
  ensureSupported(address: HubAddressV1, binding: CodingRoleAgentSnapshotV1): Promise<void>
  bind(address: HubAddressV1, binding: CodingRoleAgentSnapshotV1): Promise<void>
}

/** Main-only adapter for the private Worker turn payload. Never return this from IPC. */
export function privateCodingRoleAgentSnapshotV1(
  binding: CodingAttemptRoleBindingV1,
): CodingRoleAgentSnapshotV1 {
  return Object.freeze({
    schemaVersion: 1,
    attemptId: binding.attemptId,
    boundAt: binding.boundAt,
    snapshot: binding.snapshot,
    snapshotDigest: binding.snapshotDigest,
  })
}

export function registerCodingRoleHandlersV1(options: {
  readonly roles: RolePortV1
  readonly runtime: CodingRoleRuntimePortV1
  readonly scope: CodingRoleScopePortV1
}): void {
  registerHandler('ipc:xiaogui.coding.roles.list', async (payload): Promise<CodingRoleListOutcomeV1> => {
    const parsed = ListSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as HubAddressV1
    if (!await options.scope.isCodingSession(address)) return failure('SESSION_SCOPE_MISMATCH')
    try {
      return success({ profiles: options.roles.list() })
    } catch {
      return failure('ROLE_STORE_UNAVAILABLE')
    }
  })

  registerHandler('ipc:xiaogui.coding.roles.readForEdit', async (payload): Promise<CodingRoleReadForEditOutcomeV1> => {
    const parsed = ReadForEditSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as HubAddressV1
    if (!await options.scope.isCodingSession(address)) return failure('SESSION_SCOPE_MISMATCH')
    try {
      const profile = options.roles.readForEdit(parsed.data.profileId)
      if (!profile) return failure('PROFILE_NOT_FOUND')
      return success({ profile })
    } catch (error) {
      return mappedFailure(error)
    }
  })

  registerHandler('ipc:xiaogui.coding.roles.upsert', async (payload): Promise<CodingRoleUpsertOutcomeV1> => {
    const parsed = UpsertSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as HubAddressV1
    if (!await options.scope.isCodingSession(address)) return failure('SESSION_SCOPE_MISMATCH')
    try {
      const saved = options.roles.upsert(parsed.data.profile as CodingRoleProfileDraftV1)
      return success({ profile: publicProfile(saved) })
    } catch (error) {
      return mappedFailure(error)
    }
  })

  registerHandler('ipc:xiaogui.coding.roles.copy', async (payload): Promise<CodingRoleCopyOutcomeV1> => {
    const parsed = CopySchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as HubAddressV1
    if (!await options.scope.isCodingSession(address)) return failure('SESSION_SCOPE_MISMATCH')
    try {
      const copied = options.roles.copy(parsed.data.sourceProfileId, parsed.data.newProfileId)
      return success({ profile: publicProfile(copied) })
    } catch (error) {
      return mappedFailure(error)
    }
  })

  registerHandler('ipc:xiaogui.coding.roles.resetDefault', async (payload): Promise<CodingRoleResetDefaultOutcomeV1> => {
    const parsed = ResetDefaultSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as HubAddressV1
    if (!await options.scope.isCodingSession(address)) return failure('SESSION_SCOPE_MISMATCH')
    try {
      const reset = options.roles.resetDefault(parsed.data.profileId)
      return success({ profile: publicProfile(reset) })
    } catch (error) {
      return mappedFailure(error)
    }
  })

  registerHandler('ipc:xiaogui.coding.roles.attempt.bind', async (payload): Promise<CodingRoleAttemptOutcomeV1> => {
    const parsed = AttemptBindSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as HubAddressV1
    if (
      !await options.scope.isCodingSession(address) ||
      !await options.scope.hasAttempt(address, parsed.data.attemptId)
    ) return failure('SESSION_SCOPE_MISMATCH')
    try {
      const existing = options.roles.readAttemptBinding(parsed.data.attemptId)
      if (existing) {
        if (existing.snapshot.profileId !== parsed.data.profileId) {
          return failure('ATTEMPT_ALREADY_BOUND')
        }
        if (existing.snapshot.profileDigest !== parsed.data.expectedProfileDigest) {
          return failure('VERSION_CONFLICT')
        }
        const privateBinding = privateCodingRoleAgentSnapshotV1(existing)
        await options.runtime.ensureSupported(address, privateBinding)
        await options.runtime.bind(address, privateBinding)
        return success({ binding: publicBinding(existing) })
      }
      const profile = options.roles.readForEdit(parsed.data.profileId)
      if (!profile) return failure('PROFILE_NOT_FOUND')
      if (profile.profileDigest !== parsed.data.expectedProfileDigest) {
        return failure('VERSION_CONFLICT')
      }
      const resolved = options.roles.resolve(parsed.data.profileId)
      await options.runtime.ensureSupported(
        address,
        privateCodingRolePreflightSnapshotV1(parsed.data.attemptId, resolved),
      )
      const binding = options.roles.bindAttempt(
        parsed.data.attemptId,
        parsed.data.profileId,
      )
      await options.runtime.bind(address, privateCodingRoleAgentSnapshotV1(binding))
      return success({ binding: publicBinding(binding) })
    } catch (error) {
      return mappedFailure(error)
    }
  })

  registerHandler('ipc:xiaogui.coding.roles.attempt.read', async (payload): Promise<CodingRoleAttemptOutcomeV1> => {
    const parsed = AttemptReadSchema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_REQUEST')
    const address = parsed.data.address as HubAddressV1
    if (
      !await options.scope.isCodingSession(address) ||
      !await options.scope.hasAttempt(address, parsed.data.attemptId)
    ) return failure('SESSION_SCOPE_MISMATCH')
    try {
      const binding = options.roles.readAttemptBinding(parsed.data.attemptId)
      return success({ binding: binding ? publicBinding(binding) : null })
    } catch (error) {
      return mappedFailure(error)
    }
  })
}

function privateCodingRolePreflightSnapshotV1(
  attemptId: string,
  resolved: CodingResolvedRoleProfileV1,
): CodingRoleAgentSnapshotV1 {
  return Object.freeze({
    schemaVersion: 1,
    attemptId,
    boundAt: new Date().toISOString(),
    snapshot: resolved.snapshot,
    snapshotDigest: resolved.snapshotDigest,
  })
}

function publicBinding(binding: CodingAttemptRoleBindingV1) {
  return Object.freeze({
    schemaVersion: 1 as const,
    attemptId: binding.attemptId,
    profileId: binding.snapshot.profileId,
    role: binding.snapshot.role,
    name: binding.snapshot.name,
    description: binding.snapshot.description,
    modelSelector: binding.snapshot.modelSelector,
    runtimePolicyId: binding.snapshot.runtimePolicyId,
    effectiveToolAllowlist: Object.freeze([...binding.snapshot.effectiveToolAllowlist]),
    profileDigest: binding.snapshot.profileDigest,
    snapshotDigest: binding.snapshotDigest,
    boundAt: binding.boundAt,
  })
}

function publicProfile(profile: ReturnType<CodingRoleProfileModuleV1['upsert']>) {
  const { systemPrompt: _systemPrompt, ...summary } = profile
  return Object.freeze(summary)
}

function success<T extends object>(value: T) {
  return {
    ok: true as const,
    value: { contractVersion: XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1, ...value },
  }
}

function mappedFailure(error: unknown) {
  const code = error instanceof Error ? error.message : ''
  if (code === 'CODING_ROLE_PROFILE_NOT_FOUND') return failure('PROFILE_NOT_FOUND')
  if (code === 'CODING_ROLE_PROFILE_ALREADY_EXISTS') return failure('PROFILE_ALREADY_EXISTS')
  if (code === 'CODING_ROLE_PROFILE_NOT_DEFAULT') return failure('PROFILE_NOT_DEFAULT')
  if (code === 'CODING_ROLE_ATTEMPT_ALREADY_BOUND') return failure('ATTEMPT_ALREADY_BOUND')
  if (code === 'XIAOGUI_CODING_ROLE_MODEL_UNAVAILABLE') return failure('MODEL_UNAVAILABLE')
  if (code === 'XIAOGUI_CODING_ROLE_RUNTIME_POLICY_UNSUPPORTED') {
    return failure('RUNTIME_POLICY_UNSUPPORTED')
  }
  if (code.startsWith('XIAOGUI_CODING_ROLE_RUNTIME_')) return failure('RUNTIME_UNAVAILABLE')
  if (code.startsWith('CODING_ROLE_') && !code.includes('STORE_CORRUPT')) {
    return failure('PROFILE_INVALID')
  }
  return failure('ROLE_STORE_UNAVAILABLE')
}

function failure(code: CodingRoleControlErrorCodeV1) {
  return {
    ok: false as const,
    error: {
      code,
      messageKey: `xiaogui.coding.roles.${code.toLowerCase()}`,
    },
  }
}
