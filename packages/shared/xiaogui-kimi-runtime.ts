export const XIAOGUI_KIMI_RUNTIME_STATUSES_V1 = [
  'DISABLED',
  'CLI_NOT_FOUND',
  'VERSION_UNAPPROVED',
  'LOGIN_REQUIRED',
  'CREDENTIAL_PRESENT_UNVERIFIED',
  'LOGIN_IN_PROGRESS',
  'STATUS_UNAVAILABLE',
] as const

export type XiaoguiKimiRuntimeStatusV1 =
  (typeof XIAOGUI_KIMI_RUNTIME_STATUSES_V1)[number]

export type XiaoguiKimiRuntimeReasonCodeV1 =
  | 'PRODUCTION_DISABLED'
  | 'KIMI_CLI_NOT_FOUND'
  | 'KIMI_VERSION_UNAPPROVED'
  | 'KIMI_CREDENTIAL_MISSING'
  | 'KIMI_CREDENTIAL_PRESENT_UNVERIFIED'
  | 'KIMI_LOGIN_IN_PROGRESS'
  | 'KIMI_PRODUCTION_HOME_UNAVAILABLE'
  | 'KIMI_PROBE_UNAVAILABLE'
  | 'KIMI_CREDENTIAL_STATUS_UNAVAILABLE'
  | 'KIMI_LOGIN_LAUNCH_FAILED'
  | 'PLATFORM_UNSUPPORTED'
  | 'KIMI_COORDINATOR_CLOSED'

/** Public, path-free snapshot. A credential is evidence only, never proof of login. */
export interface XiaoguiKimiRuntimeStatusSnapshotV1 {
  readonly status: XiaoguiKimiRuntimeStatusV1
  readonly reasonCode: XiaoguiKimiRuntimeReasonCodeV1
  readonly approvedVersion: string
  readonly discoveredVersion?: string
}

/** Both Kimi IPC methods intentionally accept an empty object only. */
export type XiaoguiKimiNoParamsV1 = Record<string, never>
