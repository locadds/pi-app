import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'
import type { SessionAddressV1, SessionScopeLookupV1 } from '@shared/xiaogui-session-scope'

import type { CodingRoleRuntimePortV1, CodingRoleScopePortV1 } from './role-ipc'

interface AttemptPlanScopePortV1 {
  observe(address: SessionAddressV1): readonly { readonly attemptId: string }[]
}

interface CodingRoleWorkerPortV1 {
  inspectCodingRoleSupport(
    address: SessionAddressV1,
    binding: CodingRoleAgentSnapshotV1,
  ): Promise<unknown>
  bindCodingAttemptRole(
    address: SessionAddressV1,
    binding: CodingRoleAgentSnapshotV1,
  ): Promise<unknown>
  releaseCodingAttemptRole(
    address: SessionAddressV1,
    expectedAttemptId: string,
  ): Promise<unknown>
}

export function createCodingRoleProductionPortsV1(options: {
  readonly lookup: SessionScopeLookupV1
  readonly plans: AttemptPlanScopePortV1
  readonly workers: CodingRoleWorkerPortV1
  /** Main-only opaque-address resolver; it must not expose a session path. */
  readonly ensureSession: (address: SessionAddressV1) => Promise<void>
}): {
  readonly scope: CodingRoleScopePortV1
  readonly runtime: CodingRoleRuntimePortV1
} {
  const activeAttemptByAddress = new Map<string, string>()
  return Object.freeze({
    scope: Object.freeze({
      async isCodingSession(address: SessionAddressV1): Promise<boolean> {
        try {
          const result = await options.lookup.lookup(address)
          return result.kind === 'FOUND' && result.scope.sessionMode === 'CODING'
        } catch {
          return false
        }
      },
      hasAttempt(address: SessionAddressV1, attemptId: string): boolean {
        try {
          return options.plans.observe(address).some((attempt) => attempt.attemptId === attemptId)
        } catch {
          return false
        }
      },
    }),
    runtime: Object.freeze({
      async ensureSupported(
        address: SessionAddressV1,
        binding: CodingRoleAgentSnapshotV1,
      ): Promise<void> {
        await options.ensureSession(address)
        const key = addressKey(address)
        const activeAttemptId = activeAttemptByAddress.get(key)
        if (activeAttemptId && activeAttemptId !== binding.attemptId) {
          await options.workers.releaseCodingAttemptRole(address, activeAttemptId)
          activeAttemptByAddress.delete(key)
        }
        await options.workers.inspectCodingRoleSupport(address, binding)
      },
      async bind(
        address: SessionAddressV1,
        binding: CodingRoleAgentSnapshotV1,
      ): Promise<void> {
        await options.workers.bindCodingAttemptRole(address, binding)
        activeAttemptByAddress.set(addressKey(address), binding.attemptId)
      },
    }),
  })
}

function addressKey(address: SessionAddressV1): string {
  return `${address.projectId}:${address.sessionKey}`
}
