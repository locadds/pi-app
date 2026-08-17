import type {
  AttemptProjectionM2BV1,
  FlowId,
  HubAddressV1,
  TaskRunProjectionM2BV1,
} from './xiaogui-collaboration-hub'

/**
 * The only renderer-owned file facts accepted by the execution seam. Main
 * resolves MODIFY digests and rejects CREATE targets that already exist.
 */
export type XiaoguiTaskExecutionFileSelectionV1 =
  | { readonly operation: 'MODIFY'; readonly relativePath: string }
  | { readonly operation: 'CREATE'; readonly relativePath: string }

export interface XiaoguiTaskExecutionStartRequestV1 {
  readonly address: HubAddressV1
  readonly flowId: FlowId
  readonly prompt: string
  readonly files: readonly XiaoguiTaskExecutionFileSelectionV1[]
}

export interface XiaoguiTaskExecutionStartResultV1 {
  readonly taskRun: TaskRunProjectionM2BV1
  readonly attempt: AttemptProjectionM2BV1
}

export type XiaoguiTaskExecutionErrorCodeV1 =
  | 'SESSION_SCOPE_MISMATCH'
  | 'DESIGN_RESERVED'
  | 'WORK_NOT_SUPPORTED'
  | 'FLOW_NOT_READY'
  | 'EXECUTION_INPUT_INVALID'
  | 'EXECUTION_IN_PROGRESS'
  | 'AGENT_UNAVAILABLE'
  | 'BASELINE_UNAVAILABLE'
  | 'WORKSPACE_PREPARATION_FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'INTERNAL'

export interface XiaoguiTaskExecutionSafeErrorV1 {
  readonly code: XiaoguiTaskExecutionErrorCodeV1
  readonly messageKey: string
  readonly traceId: string
}

export type XiaoguiTaskExecutionStartOutcomeV1 =
  | { readonly ok: true; readonly value: XiaoguiTaskExecutionStartResultV1 }
  | { readonly ok: false; readonly error: XiaoguiTaskExecutionSafeErrorV1 }
