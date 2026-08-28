import type {
  TemplateIntakeFinalDecisionItemV1,
  TemplateIntakeReportV1,
} from './xiaogui-work-docx-template-intake'
import type { TemplateReviewActionV2 } from './xiaogui-work-template-review'

/** 将逐页复核器动作折算为模板整理服务的逐项决定。 */
export function summarizeTemplateReviewActionsV2(
  report: TemplateIntakeReportV1,
  actions: readonly TemplateReviewActionV2[],
): TemplateIntakeFinalDecisionItemV1[] {
  const byTarget = new Map<string, TemplateReviewActionV2[]>()
  for (const action of actions) {
    const existing = byTarget.get(action.targetId) ?? []
    existing.push(action)
    byTarget.set(action.targetId, existing)
  }

  return report.candidates.map((candidate) => {
    const targetActions = byTarget.get(candidate.candidateId) ?? []
    const action = targetActions.find((item) => item.kind !== 'KEEP') ?? targetActions[0]
    if (!action) return { candidateId: candidate.candidateId, decision: 'FIXED' }

    const riskReason = targetActions.find(
      (item) => item.highRiskOverrideReason,
    )?.highRiskOverrideReason
    const riskConfirmed = targetActions.some(
      (item) => item.highRiskOverrideConfirmed === true,
    )
    const common = {
      candidateId: candidate.candidateId,
      ...(riskReason ? { highRiskOverrideReason: riskReason } : {}),
      ...(riskConfirmed ? { highRiskOverrideConfirmed: true as const } : {}),
    }

    switch (action.kind) {
      case 'FIELD':
        return { ...common, decision: 'VARIABLE', fieldName: action.fieldName }
      case 'REMOVE':
        return { ...common, decision: 'EXCLUDE' }
      case 'REPEAT':
        return { ...common, decision: 'REPEAT', fieldName: action.blockName }
      case 'CONDITIONAL':
        return { ...common, decision: 'CONDITIONAL', fieldName: action.conditionName }
      case 'KEEP':
      case 'REPLACE_TEXT':
      case 'REPLACE_IMAGE':
        return { ...common, decision: 'FIXED' }
    }
  })
}
