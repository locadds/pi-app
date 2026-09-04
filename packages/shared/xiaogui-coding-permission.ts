/** Shared permission-mode vocabulary used by both direct CODING V2 and TaskHub V1. */
export const CODING_PERMISSION_MODES_V1 = Object.freeze([
  'CONFIRM_EACH',
  'AUTO_APPROVE',
  'FULL_AUTONOMY',
] as const)

export type CodingPermissionModeV1 = typeof CODING_PERMISSION_MODES_V1[number]

export const XIAOGUI_CODING_PERMISSION_MODE_SETTING_KEY_V1 =
  'xiaoguiCodingPermissionMode' as const
