import type {
  TemplateFieldGraphV2,
  TemplateIssueActionV2,
} from './xiaogui-template-field-graph-v2'
import type {
  TemplateReviewIssueChoiceV2,
  TemplateReviewActionV2,
  TemplateReviewDocumentV3,
  TemplateReviewRequestV3,
} from './xiaogui-work-template-review'

/** 模板资产化默认工作区；数字 4 用于与既有文档复核 V2/V3 判别。 */
export const TEMPLATE_DRAFT_REVIEW_VERSION_V2 = 4 as const

export interface TemplateDraftTargetBindingV2 {
  /** 兼容后台 Candidate 的不透明编号；默认界面不得展示。 */
  targetId: string
  fieldId?: string
  issueIds: readonly string[]
  recommendedAction: TemplateReviewActionV2
}

export interface TemplateDraftIssueChoiceV2 extends TemplateReviewIssueChoiceV2 {
  action: TemplateIssueActionV2
}

export interface TemplateDraftReviewRequestV2 {
  reviewVersion: typeof TEMPLATE_DRAFT_REVIEW_VERSION_V2
  mode: 'QUICK'
  document: TemplateReviewDocumentV3
  fieldGraph: TemplateFieldGraphV2
  targetBindings: readonly TemplateDraftTargetBindingV2[]
  recommendedActions: readonly TemplateReviewActionV2[]
  quickIssueLimit: number
  /** 现有逐段复核完整保留，只作为“高级检查”打开。 */
  advancedReview: TemplateReviewRequestV3
}
