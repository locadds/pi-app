import { describe, expect, it } from 'vitest'

import {
  XIAOGUI_GITHUB_REPOSITORY,
  XIAOGUI_INTERNAL_RC_CAPABILITIES_V1,
  XIAOGUI_PRODUCT_NAME,
  XIAOGUI_RELEASE_CHANNEL,
  XIAOGUI_WINDOWS_APP_USER_MODEL_ID,
} from './xiaogui-product'

describe('小规产品身份', () => {
  it('固定内部试用版的名称、更新源和 Windows 身份', () => {
    expect(XIAOGUI_PRODUCT_NAME).toBe('小规 Agent')
    expect(XIAOGUI_GITHUB_REPOSITORY).toBe('locadds/pi-planning-agent')
    expect(XIAOGUI_WINDOWS_APP_USER_MODEL_ID).toBe('com.xiaogui.agent')
    expect(XIAOGUI_RELEASE_CHANNEL).toBe('internal-rc')
  })

  it('不把预留能力宣传成已交付能力', () => {
    expect(XIAOGUI_INTERNAL_RC_CAPABILITIES_V1).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DESIGN', status: '预留接口' }),
        expect.objectContaining({ code: 'NODE.LAN', status: '本版不含' }),
      ]),
    )
  })
})
