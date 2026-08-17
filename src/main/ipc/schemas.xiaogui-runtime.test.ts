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
})
