import { describe, expect, it } from 'vitest'

import type { CodingPermissionIntentV1 } from '@shared/xiaogui-coding-extension-pack'
import { XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1 } from '@shared/xiaogui-coding-extension-pack'
import { evaluateCodingPermissionPolicyV1 } from './permission-policy'

function intent(operation: CodingPermissionIntentV1['operation']): CodingPermissionIntentV1 {
  return {
    schemaVersion: 1,
    attemptId: 'attempt_omp_p1',
    requestDigest: `sha256:${operation.toLowerCase()}-request`,
    operation,
    relativePaths: ['src/feature.ts'],
    dataEgress: operation === 'DATA_EGRESS' ? 'REQUESTED' : 'NONE',
    ...(operation === 'COMMAND'
      ? { actionDigest: `sha256:${'a'.repeat(64)}`, commandSummary: 'npm run typecheck' }
      : {}),
    ...(operation === 'DATA_EGRESS'
      ? { actionDigest: `sha256:${'b'.repeat(64)}`, egressDestination: 'approved.example.test' }
      : {}),
  }
}

describe('Coding permission mode P1 contract', () => {
  it('publishes exactly the three user-facing modes from one shared source', () => {
    expect(XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1.map(({ mode, label }) => ({ mode, label }))).toEqual([
      { mode: 'CONFIRM_EACH', label: '逐条确认' },
      { mode: 'AUTO_APPROVE', label: '自动通过' },
      { mode: 'FULL_AUTONOMY', label: '完全自主' },
    ])
  })

  it.each(['UNVERIFIED', 'DENIED'] as const)('never lets any mode bypass a %s TaskHub boundary', (boundaryState) => {
    for (const { mode } of XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1) {
      for (const operation of ['READ', 'WRITE', 'COMMAND', 'DATA_EGRESS'] as const) {
        expect(evaluateCodingPermissionPolicyV1({ mode, intent: intent(operation), boundaryState })).toMatchObject({
          effect: 'DENY',
          mode,
        })
      }
    }
  })

  it('maps only TaskHub-verified operations to the selected interaction policy', () => {
    const effects = Object.fromEntries(
      XIAOGUI_CODING_PERMISSION_MODE_OPTIONS_V1.flatMap(({ mode }) =>
        (['READ', 'WRITE', 'COMMAND', 'DATA_EGRESS'] as const).map((operation) => [
          `${mode}:${operation}`,
          evaluateCodingPermissionPolicyV1({ mode, intent: intent(operation), boundaryState: 'VERIFIED' }).effect,
        ]),
      ),
    )
    expect(effects).toEqual({
      'CONFIRM_EACH:READ': 'ASK_USER',
      'CONFIRM_EACH:WRITE': 'ASK_USER',
      'CONFIRM_EACH:COMMAND': 'ASK_USER',
      'CONFIRM_EACH:DATA_EGRESS': 'ASK_USER',
      'AUTO_APPROVE:READ': 'ALLOW_ONCE',
      'AUTO_APPROVE:WRITE': 'ALLOW_ONCE',
      'AUTO_APPROVE:COMMAND': 'ASK_USER',
      'AUTO_APPROVE:DATA_EGRESS': 'ASK_USER',
      'FULL_AUTONOMY:READ': 'ALLOW_ONCE',
      'FULL_AUTONOMY:WRITE': 'ALLOW_ONCE',
      'FULL_AUTONOMY:COMMAND': 'ALLOW_ONCE',
      'FULL_AUTONOMY:DATA_EGRESS': 'ALLOW_ONCE',
    })
  })
})
