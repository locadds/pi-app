import { describe, expect, it } from 'vitest'

import {
  CODING_PLAN_LIFECYCLE_STATES_V1,
  XIAOGUI_CODING_EXTENSION_MANIFESTS_V1,
  type CodingPlanProjectionV1,
} from './xiaogui-coding-extension-pack'

describe('Xiaogui Coding Extension Pack V1 contract', () => {
  it('publishes exactly the six frozen CODING modules disabled by default for the P0 gate', () => {
    expect(XIAOGUI_CODING_EXTENSION_MANIFESTS_V1).toEqual([
      expect.objectContaining({ extensionId: 'coding.context', displayName: '代码上下文与符号' }),
      expect.objectContaining({ extensionId: 'coding.permission', displayName: '命令、路径与外传权限' }),
      expect.objectContaining({ extensionId: 'coding.plan', displayName: '计划卡与任务清单' }),
      expect.objectContaining({ extensionId: 'coding.review', displayName: 'Diff 与验证审阅' }),
      expect.objectContaining({ extensionId: 'coding.checkpoint', displayName: 'Git 检查点与恢复' }),
      expect.objectContaining({ extensionId: 'coding.roles', displayName: '研究、实现、审阅角色' }),
    ])

    for (const manifest of XIAOGUI_CODING_EXTENSION_MANIFESTS_V1) {
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        allowedModes: ['CODING'],
        defaultEnabled: false,
        requiredSeams: ['PI_EXTENSION', 'TASK_HUB', 'RENDERER_EXTENSION_UI'],
      })
      expect(manifest.capabilities.length).toBeGreaterThan(0)
    }
  })

  it('freezes the Attempt-local plan lifecycle without adding a second task DAG', () => {
    expect(CODING_PLAN_LIFECYCLE_STATES_V1).toEqual([
      'AWAITING_APPROVAL',
      'APPROVED',
      'EXECUTING',
    ])

    const projection = {
      schemaVersion: 1,
      attemptId: 'attempt_1',
      source: 'TASK_OBJECTIVE_FALLBACK',
      state: 'AWAITING_APPROVAL',
      plan: {
        schemaVersion: 1,
        planId: 'plan_1',
        attemptId: 'attempt_1',
        objective: '完成任务目标',
        steps: [{
          stepId: 'fallback_execute',
          title: '完成任务目标',
          status: 'PENDING',
          validation: '按任务验收要求检查真实结果',
        }],
        constraints: ['执行前必须人工确认'],
        revision: 1,
      },
      planDigest: `sha256:${'a'.repeat(64)}`,
    } satisfies CodingPlanProjectionV1
    expect(projection.plan.attemptId).toBe(projection.attemptId)
  })
})
