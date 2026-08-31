import { describe, expect, it } from 'vitest'

import { XIAOGUI_CODING_EXTENSION_MANIFESTS_V1 } from './xiaogui-coding-extension-pack'

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
})
