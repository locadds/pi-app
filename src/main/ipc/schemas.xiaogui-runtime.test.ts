import { describe, expect, it } from 'vitest'

import { settingsSetSchema } from './schemas'

describe('xiaogui runtime settings schema', () => {
  it('accepts only a boolean production enablement value', () => {
    expect(
      settingsSetSchema.safeParse({ key: 'xiaoguiKimiProductionEnabled', value: true }).success,
    ).toBe(true)
    expect(
      settingsSetSchema.safeParse({ key: 'xiaoguiKimiProductionEnabled', value: 'true' }).success,
    ).toBe(false)
  })

  it('accepts only the shared three Coding permission modes', () => {
    for (const value of ['CONFIRM_EACH', 'AUTO_APPROVE', 'FULL_AUTONOMY']) {
      expect(settingsSetSchema.safeParse({ key: 'xiaoguiCodingPermissionMode', value }).success)
        .toBe(true)
    }
    expect(
      settingsSetSchema.safeParse({ key: 'xiaoguiCodingPermissionMode', value: 'YOLO' }).success,
    ).toBe(false)
  })
})
