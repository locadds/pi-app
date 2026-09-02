import type { XiaoguiMode } from './xiaogui-prompt-contract'

export interface ModeRecommendationV1 {
  readonly schemaVersion: 1
  readonly currentMode: XiaoguiMode
  readonly recommendedMode: XiaoguiMode
  readonly confidence: 'HIGH' | 'MEDIUM'
  readonly reasonCode:
    | 'CODE_REPOSITORY_TASK'
    | 'PLANNING_SPATIAL_TASK'
    | 'DOCUMENT_WORK_TASK'
  readonly reasonText: string
  readonly matchedSignals: readonly string[]
}
