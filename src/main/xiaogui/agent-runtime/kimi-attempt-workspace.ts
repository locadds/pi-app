import type {
  RuntimeContractTestCreateOrResumeRequestV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeWorkspaceBindingV1,
} from '@shared/xiaogui-agent-runtime'

import type { AttemptRuntimeWorkspaceAccessV1 } from '../task-hub/attempt-workspace'
import type { KimiAcpWorkspaceResolutionV1, KimiAcpWorkspaceResolverV1 } from './kimi-adapter'

export type KimiAttemptWorkspaceReasonCodeV1 =
  | 'ATTEMPT_WORKSPACE_NOT_PREPARED'
  | 'RUNTIME_WORKSPACE_BINDING_MISMATCH'

export class KimiAttemptWorkspaceError extends Error {
  constructor(readonly reasonCode: KimiAttemptWorkspaceReasonCodeV1) {
    super(reasonCode)
    this.name = 'KimiAttemptWorkspaceError'
  }
}

export interface AttemptRuntimeWorkspaceAccessPortV1 {
  runtimeAccess(attemptId: string): Promise<AttemptRuntimeWorkspaceAccessV1 | undefined>
}

export class KimiAttemptWorkspaceResolverV1 implements KimiAcpWorkspaceResolverV1 {
  constructor(
    private readonly attempts: AttemptRuntimeWorkspaceAccessPortV1,
    private readonly kimiCodeHome: string,
  ) {}

  async resolve(
    request: RuntimeCreateOrResumeRequestV1 | RuntimeContractTestCreateOrResumeRequestV1,
  ): Promise<KimiAcpWorkspaceResolutionV1> {
    const access = await this.attempts.runtimeAccess(request.scope.attemptId)
    if (!access) throw new KimiAttemptWorkspaceError('ATTEMPT_WORKSPACE_NOT_PREPARED')
    if (!isExactWorkspaceBinding(request.workspace, access.workspace)) {
      throw new KimiAttemptWorkspaceError('RUNTIME_WORKSPACE_BINDING_MISMATCH')
    }
    return {
      rootPath: access.rootPath,
      allowedFiles: access.allowedFiles,
      kimiCodeHome: this.kimiCodeHome,
    }
  }
}

const WORKSPACE_BINDING_KEYS = [
  'attemptWorktreeId',
  'worktreeRootDigest',
  'baseRevisionDigest',
  'targetProjectRootDigest',
  'writePolicy',
] as const satisfies readonly (keyof RuntimeWorkspaceBindingV1)[]

function isExactWorkspaceBinding(actual: RuntimeWorkspaceBindingV1, expected: RuntimeWorkspaceBindingV1): boolean {
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  return (
    actualKeys.length === WORKSPACE_BINDING_KEYS.length &&
    expectedKeys.length === WORKSPACE_BINDING_KEYS.length &&
    WORKSPACE_BINDING_KEYS.every(
      (key) => Object.prototype.hasOwnProperty.call(actual, key) && actual[key] === expected[key],
    )
  )
}
