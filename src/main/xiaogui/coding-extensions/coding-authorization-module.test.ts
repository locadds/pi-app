import { describe, expect, it, vi } from 'vitest'

import type { CodingPermissionIntentV1 } from '@shared/xiaogui-coding-extension-pack'
import type { ProjectId, SessionKey } from '@shared/xiaogui-session-scope'
import type { DirectCodingAuthorizationSubjectV2 } from '@shared/xiaogui-direct-coding'
import {
  CodingAuthorizationModuleV2,
  directPermissionEffectV2,
} from './coding-authorization-module'

const directSubject = {
  schemaVersion: 2 as const,
  kind: 'DIRECT_SESSION' as const,
  address: {
    projectId: `xgp1_${'a'.repeat(64)}` as ProjectId,
    sessionKey: `xgs1_${'b'.repeat(64)}` as SessionKey,
  },
} satisfies DirectCodingAuthorizationSubjectV2

describe('CodingAuthorizationModuleV2', () => {
  it('implements the frozen direct-session mode matrix and always asks for Bash/egress', () => {
    expect(directPermissionEffectV2('CONFIRM_EACH', 'READ', true)).toBe('ASK')
    expect(directPermissionEffectV2('CONFIRM_EACH', 'EDIT', true)).toBe('ASK')
    expect(directPermissionEffectV2('AUTO_APPROVE', 'READ', true)).toBe('ALLOW')
    expect(directPermissionEffectV2('AUTO_APPROVE', 'WRITE', true)).toBe('ALLOW')
    expect(directPermissionEffectV2('AUTO_APPROVE', 'WRITE', false)).toBe('ASK')
    expect(directPermissionEffectV2('FULL_AUTONOMY', 'WRITE', false)).toBe('ALLOW')
    for (const mode of ['CONFIRM_EACH', 'AUTO_APPROVE', 'FULL_AUTONOMY'] as const) {
      expect(directPermissionEffectV2(mode, 'BASH', false)).toBe('ASK')
      expect(directPermissionEffectV2(mode, 'DATA_EGRESS', false)).toBe('ASK')
    }
  })

  it('shows only allow-once/deny for a direct request and keeps TaskHub V1 behind its adapter', async () => {
    const directUi = { request: vi.fn(async () => 'ALLOW_ONCE' as const) }
    const taskHub = { decide: vi.fn(async () => 'ALLOW_ONCE' as const) }
    const module = new CodingAuthorizationModuleV2({ directUi, taskHub })

    await expect(module.decideDirect({
      subject: directSubject,
      requestDigest: `sha256:${'c'.repeat(64)}`,
      operation: 'BASH',
      mode: 'FULL_AUTONOMY',
      existingFile: false,
      commandPreview: 'npm test',
    })).resolves.toEqual({ decision: 'ALLOW_ONCE', reasonCode: 'USER_ALLOWED_ONCE' })
    expect(directUi.request).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 2,
      subject: 'DIRECT_SESSION',
      operation: 'BASH',
      choices: ['ALLOW_ONCE', 'DENY'],
      warning: expect.stringContaining('不能自动撤销'),
    }))

    const intent = taskHubIntent()
    await expect(module.decideTaskHub({
      subject: { schemaVersion: 2, kind: 'TASKHUB_ATTEMPT', attemptId: intent.attemptId },
      intent,
    })).resolves.toBe('ALLOW_ONCE')
    expect(taskHub.decide).toHaveBeenCalledWith(intent)
  })

  it('fails closed for mismatched subjects and UI failure', async () => {
    const taskHub = { decide: vi.fn(async () => 'ALLOW_ONCE' as const) }
    const module = new CodingAuthorizationModuleV2({
      directUi: { request: vi.fn(async () => { throw new Error('window closed') }) },
      taskHub,
    })
    await expect(module.decideDirect({
      subject: directSubject,
      requestDigest: `sha256:${'d'.repeat(64)}`,
      operation: 'WRITE',
      mode: 'CONFIRM_EACH',
      existingFile: false,
      relativePath: 'src/new.ts',
    })).resolves.toEqual({ decision: 'DENY', reasonCode: 'USER_OR_POLICY_DENIED' })

    const intent = taskHubIntent()
    await expect(module.decideTaskHub({
      subject: { schemaVersion: 2, kind: 'TASKHUB_ATTEMPT', attemptId: 'another-attempt' },
      intent,
    })).resolves.toBe('DENY')
    expect(taskHub.decide).not.toHaveBeenCalled()
  })
})

function taskHubIntent(): CodingPermissionIntentV1 {
  return {
    schemaVersion: 1,
    attemptId: 'attempt-v1',
    requestDigest: `sha256:${'e'.repeat(64)}`,
    operation: 'WRITE',
    relativePaths: ['src/a.ts'],
    dataEgress: 'NONE',
  }
}
