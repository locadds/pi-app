import { afterEach, describe, expect, it, vi } from 'vitest'
import { readOfficeSurfaceModeV1 } from './xiaogui-office-surface'

afterEach(() => vi.unstubAllEnvs())

describe('院内候选 Office 默认入口', () => {
  it('无需测试标记即可打开已验 DOCX Surface', () => {
    vi.stubEnv('XIAOGUI_OFFICE_SURFACE', undefined)
    expect(readOfficeSurfaceModeV1()).toBe('UNIVER_PREFERRED')
  })
  it('仍允许显式关闭且不接受未知模式', () => {
    expect(readOfficeSurfaceModeV1('OFF')).toBe('OFF')
    expect(readOfficeSurfaceModeV1('unknown')).toBe('OFF')
  })
})
