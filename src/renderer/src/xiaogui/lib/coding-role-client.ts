import type { HubAddressV1 } from '@shared/xiaogui-collaboration-hub'
import {
  XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1,
  type CodingRoleAttemptOutcomeV1,
  type CodingRoleAttemptProjectionV1,
  type CodingRoleCopyOutcomeV1,
  type CodingRoleControlErrorCodeV1,
  type CodingRoleControlErrorV1,
  type CodingRoleListOutcomeV1,
  type CodingRoleProfileEditorDraftV1,
  type CodingRoleProfileSummaryProjectionV1,
  type CodingRoleReadForEditOutcomeV1,
  type CodingRoleResetDefaultOutcomeV1,
  type CodingRoleUpsertOutcomeV1,
} from '@shared/xiaogui-coding-role-control'

import { ipcClient } from '@renderer/lib/ipc-client'

const CONTRACT = XIAOGUI_CODING_ROLE_CONTROL_VERSION_V1
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const DIGEST = /^sha256:[0-9a-f]{64}$/
const MESSAGE_KEY = /^[a-z0-9._-]{1,160}$/i
const ROLES = new Set(['RESEARCH', 'IMPLEMENT', 'REVIEW'])
const ERROR_CODES = new Set<CodingRoleControlErrorCodeV1>([
  'INVALID_REQUEST',
  'SESSION_SCOPE_MISMATCH',
  'PROFILE_NOT_FOUND',
  'PROFILE_INVALID',
  'PROFILE_ALREADY_EXISTS',
  'PROFILE_NOT_DEFAULT',
  'VERSION_CONFLICT',
  'ATTEMPT_ALREADY_BOUND',
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_POLICY_UNSUPPORTED',
  'MODEL_UNAVAILABLE',
  'ROLE_STORE_UNAVAILABLE',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isSafeError(value: unknown): value is CodingRoleControlErrorV1 {
  return isRecord(value)
    && hasExactKeys(value, ['code', 'messageKey'])
    && ERROR_CODES.has(value.code as CodingRoleControlErrorCodeV1)
    && typeof value.messageKey === 'string'
    && MESSAGE_KEY.test(value.messageKey)
}

function isToolAllowlist(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= 8
    && value.every((tool) => typeof tool === 'string' && /^[a-z0-9._:-]{1,80}$/i.test(tool))
}

function isProfileSummary(value: unknown): value is CodingRoleProfileSummaryProjectionV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'profileId',
    'role',
    'name',
    'description',
    'modelSelector',
    'runtimePolicyId',
    'toolAllowlist',
    'profileDigest',
    'updatedAt',
  ])) return false
  return value.schemaVersion === 1
    && typeof value.profileId === 'string'
    && SAFE_ID.test(value.profileId)
    && ROLES.has(String(value.role))
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && typeof value.description === 'string'
    && value.description.trim().length > 0
    && typeof value.modelSelector === 'string'
    && value.modelSelector.length > 0
    && typeof value.runtimePolicyId === 'string'
    && value.runtimePolicyId.length > 0
    && isToolAllowlist(value.toolAllowlist)
    && typeof value.profileDigest === 'string'
    && DIGEST.test(value.profileDigest)
    && typeof value.updatedAt === 'string'
    && Number.isFinite(Date.parse(value.updatedAt))
}

function isProfileForEdit(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'profileId',
    'role',
    'name',
    'description',
    'systemPrompt',
    'modelSelector',
    'runtimePolicyId',
    'toolAllowlist',
    'profileDigest',
    'updatedAt',
  ])) return false
  const { systemPrompt, ...summary } = value
  return typeof systemPrompt === 'string'
    && systemPrompt.trim().length > 0
    && isProfileSummary(summary)
}

function isBinding(value: unknown): value is CodingRoleAttemptProjectionV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'attemptId',
    'profileId',
    'role',
    'name',
    'description',
    'modelSelector',
    'runtimePolicyId',
    'effectiveToolAllowlist',
    'profileDigest',
    'snapshotDigest',
    'boundAt',
  ])) return false
  return value.schemaVersion === 1
    && typeof value.attemptId === 'string'
    && SAFE_ID.test(value.attemptId)
    && typeof value.profileId === 'string'
    && SAFE_ID.test(value.profileId)
    && ROLES.has(String(value.role))
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && typeof value.description === 'string'
    && typeof value.modelSelector === 'string'
    && typeof value.runtimePolicyId === 'string'
    && isToolAllowlist(value.effectiveToolAllowlist)
    && typeof value.profileDigest === 'string'
    && DIGEST.test(value.profileDigest)
    && typeof value.snapshotDigest === 'string'
    && DIGEST.test(value.snapshotDigest)
    && typeof value.boundAt === 'string'
    && Number.isFinite(Date.parse(value.boundAt))
}

function unavailable(): { readonly ok: false; readonly error: CodingRoleControlErrorV1 } {
  return { ok: false, error: { code: 'ROLE_STORE_UNAVAILABLE', messageKey: 'xiaogui.coding.roles.ipc' } }
}

function failureOrUnavailable(response: Record<string, unknown>): { readonly ok: false; readonly error: CodingRoleControlErrorV1 } {
  return hasExactKeys(response, ['ok', 'error']) && response.ok === false && isSafeError(response.error)
    ? response as { readonly ok: false; readonly error: CodingRoleControlErrorV1 }
    : unavailable()
}

export async function listCodingRoles(address: HubAddressV1): Promise<CodingRoleListOutcomeV1> {
  try {
    const response: unknown = await ipcClient.invoke('xiaogui.coding.roles.list', { contractVersion: CONTRACT, address })
    if (!isRecord(response)) return unavailable()
    if (response.ok !== true) return failureOrUnavailable(response)
    if (!hasExactKeys(response, ['ok', 'value']) || !isRecord(response.value)) return unavailable()
    const value = response.value
    if (
      !hasExactKeys(value, ['contractVersion', 'profiles'])
      || value.contractVersion !== CONTRACT
      || !Array.isArray(value.profiles)
      || !value.profiles.every(isProfileSummary)
    ) return unavailable()
    const ids = value.profiles.map((profile) => profile.profileId)
    return new Set(ids).size === ids.length ? response as CodingRoleListOutcomeV1 : unavailable()
  } catch {
    return unavailable()
  }
}

export async function readCodingRoleForEdit(
  address: HubAddressV1,
  profileId: string,
): Promise<CodingRoleReadForEditOutcomeV1> {
  try {
    const response: unknown = await ipcClient.invoke('xiaogui.coding.roles.readForEdit', {
      contractVersion: CONTRACT,
      address,
      profileId,
    })
    if (!isRecord(response)) return unavailable()
    if (response.ok !== true) return failureOrUnavailable(response)
    if (!hasExactKeys(response, ['ok', 'value']) || !isRecord(response.value)) return unavailable()
    const value = response.value
    return hasExactKeys(value, ['contractVersion', 'profile'])
      && value.contractVersion === CONTRACT
      && isProfileForEdit(value.profile)
      && (value.profile as { profileId: string }).profileId === profileId
      ? response as CodingRoleReadForEditOutcomeV1
      : unavailable()
  } catch {
    return unavailable()
  }
}

export async function saveCodingRole(
  address: HubAddressV1,
  profile: CodingRoleProfileEditorDraftV1,
): Promise<CodingRoleUpsertOutcomeV1> {
  try {
    const response: unknown = await ipcClient.invoke('xiaogui.coding.roles.upsert', {
      contractVersion: CONTRACT,
      address,
      profile,
    })
    if (!isRecord(response)) return unavailable()
    if (response.ok !== true) return failureOrUnavailable(response)
    if (!hasExactKeys(response, ['ok', 'value']) || !isRecord(response.value)) return unavailable()
    const value = response.value
    return hasExactKeys(value, ['contractVersion', 'profile'])
      && value.contractVersion === CONTRACT
      && isProfileSummary(value.profile)
      && value.profile.profileId === profile.profileId
      ? response as CodingRoleUpsertOutcomeV1
      : unavailable()
  } catch {
    return unavailable()
  }
}

export async function copyCodingRole(
  address: HubAddressV1,
  sourceProfileId: string,
  newProfileId: string,
): Promise<CodingRoleCopyOutcomeV1> {
  if (!SAFE_ID.test(sourceProfileId) || !SAFE_ID.test(newProfileId) || sourceProfileId === newProfileId) {
    return unavailable()
  }
  return profileMutationRequest('xiaogui.coding.roles.copy', address, {
    sourceProfileId,
    newProfileId,
  }, newProfileId)
}

export async function resetDefaultCodingRole(
  address: HubAddressV1,
  profileId: string,
): Promise<CodingRoleResetDefaultOutcomeV1> {
  if (!SAFE_ID.test(profileId)) return unavailable()
  return profileMutationRequest('xiaogui.coding.roles.resetDefault', address, { profileId }, profileId)
}

export async function bindCodingAttemptRole(
  address: HubAddressV1,
  attemptId: string,
  profile: CodingRoleProfileSummaryProjectionV1,
): Promise<CodingRoleAttemptOutcomeV1> {
  return roleAttemptRequest('xiaogui.coding.roles.attempt.bind', address, attemptId, {
    profileId: profile.profileId,
    expectedProfileDigest: profile.profileDigest,
  }, profile.profileId)
}

export async function readCodingAttemptRole(
  address: HubAddressV1,
  attemptId: string,
): Promise<CodingRoleAttemptOutcomeV1> {
  return roleAttemptRequest('xiaogui.coding.roles.attempt.read', address, attemptId, {}, undefined)
}

async function roleAttemptRequest(
  channel: string,
  address: HubAddressV1,
  attemptId: string,
  extra: Record<string, unknown>,
  expectedProfileId: string | undefined,
): Promise<CodingRoleAttemptOutcomeV1> {
  try {
    const response: unknown = await ipcClient.invoke(channel, { contractVersion: CONTRACT, address, attemptId, ...extra })
    if (!isRecord(response)) return unavailable()
    if (response.ok !== true) return failureOrUnavailable(response)
    if (!hasExactKeys(response, ['ok', 'value']) || !isRecord(response.value)) return unavailable()
    const value = response.value
    if (!hasExactKeys(value, ['contractVersion', 'binding']) || value.contractVersion !== CONTRACT) return unavailable()
    if (value.binding === null) return expectedProfileId === undefined ? response as CodingRoleAttemptOutcomeV1 : unavailable()
    return isBinding(value.binding)
      && value.binding.attemptId === attemptId
      && (expectedProfileId === undefined || value.binding.profileId === expectedProfileId)
      ? response as CodingRoleAttemptOutcomeV1
      : unavailable()
  } catch {
    return unavailable()
  }
}

async function profileMutationRequest(
  channel: 'xiaogui.coding.roles.copy' | 'xiaogui.coding.roles.resetDefault',
  address: HubAddressV1,
  fields: Record<string, unknown>,
  expectedProfileId: string,
): Promise<CodingRoleCopyOutcomeV1 | CodingRoleResetDefaultOutcomeV1> {
  try {
    const response: unknown = await ipcClient.invoke(channel, { contractVersion: CONTRACT, address, ...fields })
    if (!isRecord(response)) return unavailable()
    if (response.ok !== true) return failureOrUnavailable(response)
    if (!hasExactKeys(response, ['ok', 'value']) || !isRecord(response.value)) return unavailable()
    const value = response.value
    return hasExactKeys(value, ['contractVersion', 'profile'])
      && value.contractVersion === CONTRACT
      && isProfileSummary(value.profile)
      && value.profile.profileId === expectedProfileId
      ? response as CodingRoleCopyOutcomeV1 | CodingRoleResetDefaultOutcomeV1
      : unavailable()
  } catch {
    return unavailable()
  }
}
