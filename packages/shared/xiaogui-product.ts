/** 小规桌面端对外身份。内部兼容键仍可保留 pi-desktop 前缀。 */
export const XIAOGUI_PRODUCT_NAME = '小规 Agent'
export const XIAOGUI_GITHUB_REPOSITORY = 'locadds/pi-planning-agent'
export const XIAOGUI_GITHUB_URL = `https://github.com/${XIAOGUI_GITHUB_REPOSITORY}`
export const XIAOGUI_WINDOWS_APP_USER_MODEL_ID = 'com.xiaogui.agent'
export const XIAOGUI_RELEASE_CHANNEL = 'internal-rc' as const

export type XiaoguiReleaseCapabilityStatusV1 =
  | '可试用'
  | '仅本机'
  | '预留接口'
  | '本版不含'

export type XiaoguiReleaseCapabilityV1 = {
  code: string
  name: string
  status: XiaoguiReleaseCapabilityStatusV1
}

/**
 * 0.3.0-rc.1 的公开能力口径。它只描述产品承诺，不替代各模块的运行时能力清单。
 */
export const XIAOGUI_INTERNAL_RC_CAPABILITIES_V1: readonly XiaoguiReleaseCapabilityV1[] = [
  { code: 'WORK', name: '日常工作与文档处理', status: '可试用' },
  { code: 'CODING', name: '编码协作闭环', status: '可试用' },
  { code: 'TASK_HUB.LOCAL', name: '本机应用中台', status: '仅本机' },
  { code: 'DESIGN', name: '规划设计', status: '预留接口' },
  { code: 'NODE.LAN', name: '局域网小规互联', status: '本版不含' },
] as const
