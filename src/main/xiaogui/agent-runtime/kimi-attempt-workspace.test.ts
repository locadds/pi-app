import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RuntimeCreateOrResumeRequestV1, RuntimeWorkspaceBindingV1 } from '@shared/xiaogui-agent-runtime'
import type { AttemptRuntimeWorkspaceAccessV1 } from '../task-hub/attempt-workspace'
import {
  KimiAttemptWorkspaceError,
  KimiAttemptWorkspaceResolverV1,
  type AttemptRuntimeWorkspaceAccessPortV1,
} from './kimi-attempt-workspace'

const WORKSPACE: RuntimeWorkspaceBindingV1 = {
  attemptWorktreeId: 'xhbwt_attempt',
  worktreeRootDigest: 'sha256:worktree',
  baseRevisionDigest: 'sha256:base',
  targetProjectRootDigest: 'sha256:project',
  writePolicy: 'ATTEMPT_WORKTREE_ONLY',
}

const ACCESS: AttemptRuntimeWorkspaceAccessV1 = {
  workspace: WORKSPACE,
  rootPath: resolve('attempt-worktree'),
  allowedFiles: [
    { relativePath: 'src/existing.txt', contentDigest: 'sha256:existing' },
    { relativePath: 'src/new-file.txt', contentDigest: 'sha256:new' },
  ],
}

class FakeAttemptRuntimeAccessV1 implements AttemptRuntimeWorkspaceAccessPortV1 {
  readonly attemptIds: string[] = []

  constructor(private readonly access: AttemptRuntimeWorkspaceAccessV1 | undefined) {}

  async runtimeAccess(attemptId: string): Promise<AttemptRuntimeWorkspaceAccessV1 | undefined> {
    this.attemptIds.push(attemptId)
    return this.access
  }
}

describe('KimiAttemptWorkspaceResolverV1', () => {
  it('resolves the scoped Attempt through the private access seam and injects the isolated Kimi home', async () => {
    const attempts = new FakeAttemptRuntimeAccessV1(ACCESS)
    const kimiCodeHome = resolve('kimi-private-home')
    const resolver = new KimiAttemptWorkspaceResolverV1(attempts, kimiCodeHome)

    await expect(resolver.resolve(runtimeRequest())).resolves.toEqual({
      rootPath: ACCESS.rootPath,
      allowedFiles: ACCESS.allowedFiles,
      kimiCodeHome,
    })
    expect(attempts.attemptIds).toEqual(['xhba_attempt'])
  })

  it('rejects an unprepared Attempt and every workspace binding mismatch', async () => {
    const missing = new KimiAttemptWorkspaceResolverV1(
      new FakeAttemptRuntimeAccessV1(undefined),
      resolve('kimi-private-home'),
    )
    await expect(missing.resolve(runtimeRequest())).rejects.toMatchObject({
      reasonCode: 'ATTEMPT_WORKSPACE_NOT_PREPARED',
    })

    const resolver = new KimiAttemptWorkspaceResolverV1(
      new FakeAttemptRuntimeAccessV1(ACCESS),
      resolve('kimi-private-home'),
    )
    const mismatches: RuntimeWorkspaceBindingV1[] = [
      { ...WORKSPACE, attemptWorktreeId: 'xhbwt_other' },
      { ...WORKSPACE, worktreeRootDigest: 'sha256:other-worktree' },
      { ...WORKSPACE, baseRevisionDigest: 'sha256:other-base' },
      { ...WORKSPACE, targetProjectRootDigest: 'sha256:other-project' },
      { ...WORKSPACE, writePolicy: 'PROJECT_ROOT' } as unknown as RuntimeWorkspaceBindingV1,
      { ...WORKSPACE, unexpected: 'not-opaque-contract' } as RuntimeWorkspaceBindingV1,
    ]
    for (const workspace of mismatches) {
      await expect(resolver.resolve(runtimeRequest(workspace))).rejects.toMatchObject({
        name: KimiAttemptWorkspaceError.name,
        reasonCode: 'RUNTIME_WORKSPACE_BINDING_MISMATCH',
      })
    }
  })
})

function runtimeRequest(workspace: RuntimeWorkspaceBindingV1 = WORKSPACE): RuntimeCreateOrResumeRequestV1 {
  const selection = {
    adapterId: 'kimi-acp',
    runtimeKind: 'KIMI' as const,
    protocol: 'ACP' as const,
    capabilityDigest: 'sha256:capability',
    approvalStatus: 'APPROVED_FOR_PRODUCTION' as const,
    diagnosticOnly: false as const,
    stream: 'PUSH' as const,
    interrupt: 'ACKED' as const,
    inspect: 'RECONCILE' as const,
  }
  return {
    requestId: 'runtime-request',
    scope: {
      projectId: 'xgp1_project',
      sessionKey: 'xhbs_session',
      sessionMode: 'CODING',
      flowId: 'xhbf_flow',
      taskRunId: 'xhbr_run',
      attemptId: 'xhba_attempt',
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'xhbw_receipt',
      workspaceReceiptDigest: 'sha256:receipt',
    },
    workspace,
    selection,
    productionPolicy: { allowedSelections: [selection], rejectDiagnosticOnly: true },
    promptEnvelopeRef: {
      refId: 'xhrp_prompt',
      digest: 'sha256:prompt',
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
  }
}
