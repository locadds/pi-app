import type { RuntimeWorkModeV1 } from '@shared/xiaogui-agent-runtime'

/** Main-owned versions; frozen in existing task/delivery receipts, not model input. */
export const MODE_VERIFICATION_POLICY_V1 = {
  CODING: { task: 'xiaogui.coding.task.v1', delivery: 'xiaogui.coding.delivery.v1', checks: ['typescript.web', 'typescript.node'] },
  WORK: { task: 'xiaogui.work.report.task.v1', delivery: 'xiaogui.work.report.delivery.v1', checks: ['work.report-docx'] },
  DESIGN: { task: 'xiaogui.design.project.task.v1', delivery: 'xiaogui.design.project.delivery.v1', checks: ['design.project'] },
} as const

export function modeForVerificationConfigV1(version: string): RuntimeWorkModeV1 | null {
  for (const mode of ['WORK', 'DESIGN', 'CODING'] as const) {
    const policy = MODE_VERIFICATION_POLICY_V1[mode]
    if (policy.task === version || policy.delivery === version) return mode
  }
  return null
}
