import { createHash } from 'node:crypto'

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'

const KNOWN_TOOL_ORDER = Object.freeze(['read', 'bash', 'edit', 'write'] as const)
const KNOWN_TOOLS = new Set<string>(KNOWN_TOOL_ORDER)
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i

export interface XiaoguiCodingRoleGuardExtensionV1 {
  readonly name: 'xiaogui-coding-role-guard-v1'
  readonly hidden: true
  readonly factory: ExtensionFactory
}

/** Validate and freeze the private Main-owned Attempt role binding. */
export function freezeCodingRoleAgentSnapshotV1(value: unknown): CodingRoleAgentSnapshotV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.snapshot)) invalid()
  const input = value as unknown as CodingRoleAgentSnapshotV1
  const role = input.snapshot.role
  if (
    !SAFE_ID_PATTERN.test(input.attemptId) ||
    !Number.isFinite(Date.parse(input.boundAt)) ||
    input.snapshot.schemaVersion !== 1 ||
    !SAFE_ID_PATTERN.test(input.snapshot.profileId) ||
    (role !== 'RESEARCH' && role !== 'IMPLEMENT' && role !== 'REVIEW') ||
    !validText(input.snapshot.name, 1, 80) ||
    !validText(input.snapshot.description, 1, 500) ||
    !validText(input.snapshot.systemPrompt, 1, 20_000) ||
    !validSelector(input.snapshot.modelSelector) ||
    !validSelector(input.snapshot.runtimePolicyId) ||
    !DIGEST_PATTERN.test(input.snapshot.profileDigest) ||
    !DIGEST_PATTERN.test(input.snapshotDigest)
  ) invalid()

  const requestedToolAllowlist = canonicalTools(input.snapshot.requestedToolAllowlist)
  const effectiveToolAllowlist = canonicalTools(input.snapshot.effectiveToolAllowlist)
  const expectedEffective = role === 'IMPLEMENT'
    ? requestedToolAllowlist
    : requestedToolAllowlist.filter((tool) => tool === 'read')
  if (!sameStrings(effectiveToolAllowlist, expectedEffective)) invalid()

  const snapshot = Object.freeze({
    schemaVersion: 1 as const,
    profileId: input.snapshot.profileId,
    role,
    name: input.snapshot.name.trim(),
    description: input.snapshot.description.trim(),
    systemPrompt: input.snapshot.systemPrompt.trim(),
    modelSelector: input.snapshot.modelSelector,
    runtimePolicyId: input.snapshot.runtimePolicyId,
    requestedToolAllowlist: Object.freeze(requestedToolAllowlist),
    effectiveToolAllowlist: Object.freeze(effectiveToolAllowlist),
    profileDigest: input.snapshot.profileDigest,
  })
  if (digest(snapshot) !== input.snapshotDigest) invalid()

  return Object.freeze({
    schemaVersion: 1,
    attemptId: input.attemptId,
    boundAt: new Date(input.boundAt).toISOString(),
    snapshot,
    snapshotDigest: input.snapshotDigest,
  })
}

/**
 * Pi Extension seam for the frozen Attempt role. Active-tool filtering is only
 * discoverability; this hook is the host-side effect upper bound.
 */
export function createXiaoguiCodingRoleGuardExtensionV1(
  source: () => CodingRoleAgentSnapshotV1 | null,
): XiaoguiCodingRoleGuardExtensionV1 {
  const factory: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', (event) => {
      const binding = source()
      if (!binding) {
        return {
          systemPrompt: [
            event.systemPrompt,
            '',
            '【小规受控角色：尚未绑定】',
            '当前仅允许只读查看；选择并绑定实现角色后，才可请求命令或写入操作。',
          ].join('\n'),
        }
      }
      return {
        systemPrompt: [
          event.systemPrompt,
          '',
          `【小规受控角色：${displayRole(binding.snapshot.role)}】`,
          binding.snapshot.systemPrompt,
        ].join('\n'),
      }
    })

    pi.on('tool_call', (event) => {
      const binding = source()
      if (!binding && event.toolName === 'read') return undefined
      if (!binding) {
        return {
          block: true,
          reason: 'XIAOGUI_CODING_ROLE_BINDING_REQUIRED',
          terminate: true,
        }
      }
      if (binding.snapshot.effectiveToolAllowlist.includes(event.toolName)) return undefined
      return {
        block: true,
        reason: 'XIAOGUI_CODING_ROLE_TOOL_BLOCKED',
        terminate: true,
      }
    })
  }
  return Object.freeze({
    name: 'xiaogui-coding-role-guard-v1',
    hidden: true,
    factory,
  })
}

function canonicalTools(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > KNOWN_TOOL_ORDER.length * 2) invalid()
  for (const tool of value) {
    if (typeof tool !== 'string' || !KNOWN_TOOLS.has(tool)) invalid()
  }
  const selected = new Set(value)
  return KNOWN_TOOL_ORDER.filter((tool) => selected.has(tool))
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function displayRole(role: CodingRoleAgentSnapshotV1['snapshot']['role']): string {
  if (role === 'RESEARCH') return '研究'
  if (role === 'REVIEW') return '审阅'
  return '实现'
}

function validText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return normalized.length >= min && normalized.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
}

function validSelector(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(value)
    && !value.includes('..')
    && !value.includes('//')
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(): never {
  throw new Error('XIAOGUI_CODING_ROLE_SNAPSHOT_INVALID')
}
