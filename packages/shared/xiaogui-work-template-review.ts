/**
 * WORK 内置文档复核器 V2 的无路径共享契约。
 *
 * 共享对象只包含显示信息、逻辑锚点和主进程签发的不透明令牌。源文件、
 * LibreOffice、PDF、OOXML 和模板库的实际路径必须始终留在主进程私有状态中。
 * 所有文档序号从 1 开始；文字范围使用 JavaScript UTF-16 偏移，结束位置不包含在内。
 */

export const TEMPLATE_REVIEW_VERSION_V2 = 2 as const;
export const TEMPLATE_REVIEW_MAX_PREVIEW_CHARS_V2 = 500 as const;

export type TemplateReviewInputFormatV2 = "DOC" | "DOCX";
export type TemplateReviewRenderModeV2 = "PDF" | "STRUCTURED_FALLBACK";

export type TemplateReviewDocumentStatusV2 =
  | "PREPARING"
  | "REVIEWING"
  | "PREVIEWING"
  | "CONFIRMED"
  | "STALE"
  | "CANCELLED";

/** 由主进程签发、只在当前复核会话有效；它不是文件路径或 URL。 */
export type TemplateReviewPageTokenV2 = string;

export interface TemplateReviewPageV2 {
  pageNumber: number;
  pageToken: TemplateReviewPageTokenV2;
  widthPoints: number;
  heightPoints: number;
  textLayerAvailable: boolean;
}

export type TemplateReviewRenderWarningCodeV2 =
  | "LIBREOFFICE_UNAVAILABLE"
  | "LIBREOFFICE_CONVERSION_FAILED"
  | "PDF_TEXT_MAPPING_FAILED"
  | "TARGET_LOCATION_UNMAPPED"
  | "STRUCTURED_FALLBACK_ACTIVE"
  | "OTHER";

export interface TemplateReviewRenderWarningV2 {
  code: TemplateReviewRenderWarningCodeV2;
  message: string;
  targetIds?: readonly string[];
}

export interface TemplateReviewDocumentV2 {
  reviewVersion: typeof TEMPLATE_REVIEW_VERSION_V2;
  reviewId: string;
  status: TemplateReviewDocumentStatusV2;
  source: {
    displayName: string;
    sha256: string;
    byteLength: number;
    inputFormat: TemplateReviewInputFormatV2;
  };
  render: {
    mode: TemplateReviewRenderModeV2;
    pageCount: number | null;
    pages: readonly TemplateReviewPageV2[];
    warnings: readonly TemplateReviewRenderWarningV2[];
  };
  targetCount: number;
  pendingTargetCount: number;
  resolvedTargetCount: number;
  unmappedTargetCount: number;
  requiresHumanConfirmation: true;
  sourceReadOnly: true;
  createdAt: string;
  updatedAt: string;
}

export type TemplateReviewLogicalPartV2 =
  | "BODY"
  | "HEADER"
  | "FOOTER"
  | "TABLE_CELL"
  | "TEXT_BOX"
  | "DRAWING"
  | "PAGE_IMAGE"
  | "UNMAPPED";

export interface TemplateReviewTextRangeV2 {
  /** 相对当前逻辑锚点文本的 UTF-16 偏移。 */
  startUtf16: number;
  /** 结束位置不包含在内，必须严格大于 startUtf16。 */
  endUtf16Exclusive: number;
}

export interface TemplateReviewSourceAnchorV2 {
  part: TemplateReviewLogicalPartV2;
  sectionIndex?: number;
  partIndex?: number;
  paragraphIndex?: number;
  tableIndex?: number;
  rowIndex?: number;
  cellIndex?: number;
  drawingIndex?: number;
  textRange?: TemplateReviewTextRangeV2;
}

/** PDF 坐标，原点及方向由 PDF.js viewport 决定，单位为 point。 */
export interface TemplateReviewPageRegionV2 {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TemplateReviewTargetKindV2 =
  "TEXT" | "TABLE_CELL" | "IMAGE" | "DRAWING" | "UNMAPPED";
export type TemplateReviewTargetStatusV2 = "PENDING" | "RESOLVED";
export type TemplateReviewHighlightV2 = "YELLOW" | "NONE";

export type TemplateReviewRiskFlagV2 =
  | "SIGNATURE"
  | "SEAL"
  | "CONTACT_INFORMATION"
  | "OLD_PROJECT_DRAWING"
  | "SCANNED_ATTACHMENT"
  | "FLOATING_OBJECT"
  | "TEXT_BOX"
  | "LOW_CONFIDENCE"
  | "PARSER_EXCEPTION"
  | "OTHER";

export interface TemplateReviewTargetV2 {
  targetId: string;
  kind: TemplateReviewTargetKindV2;
  /** 最多 500 个 Unicode 字符；图片只能返回中文说明，不返回二进制。 */
  preview: string;
  sourceAnchor: TemplateReviewSourceAnchorV2;
  pageRegions: readonly TemplateReviewPageRegionV2[];
  reason: string;
  confidence: number | null;
  riskFlags: readonly TemplateReviewRiskFlagV2[];
  highlight: TemplateReviewHighlightV2;
  status: TemplateReviewTargetStatusV2;
  highRisk: boolean;
}

interface TemplateReviewActionBaseV2 {
  targetId: string;
  /** 省略时作用于完整 target；填写时必须落在 target 的逻辑文字范围内。 */
  range?: TemplateReviewTextRangeV2;
  /** 高风险内容不再按默认移除处理时必填。 */
  highRiskOverrideReason?: string;
  /** 只有界面完成第二次确认后才允许为 true。 */
  highRiskOverrideConfirmed?: true;
}

export type TemplateReviewActionV2 =
  | (TemplateReviewActionBaseV2 & { kind: "KEEP" })
  | (TemplateReviewActionBaseV2 & {
      kind: "REPLACE_TEXT";
      replacementText: string;
    })
  | (TemplateReviewActionBaseV2 & { kind: "FIELD"; fieldName: string })
  | (TemplateReviewActionBaseV2 & { kind: "REMOVE" })
  | (TemplateReviewActionBaseV2 & {
      kind: "REPLACE_IMAGE";
      replacementImageToken: string;
    })
  | (TemplateReviewActionBaseV2 & { kind: "REPEAT"; blockName: string })
  | (TemplateReviewActionBaseV2 & {
      kind: "CONDITIONAL";
      conditionName: string;
    });

/**
 * SPLIT 只是界面操作，不是最终决定。界面把一个文字目标拆成至少两个互不重叠的
 * 子范围，再分别产生 TemplateReviewActionV2。
 */
export interface TemplateReviewSplitOperationV2 {
  targetId: string;
  ranges: readonly TemplateReviewTextRangeV2[];
}

export interface TemplateReviewRequestV2 {
  reviewVersion: typeof TEMPLATE_REVIEW_VERSION_V2;
  document: TemplateReviewDocumentV2;
  targets: readonly TemplateReviewTargetV2[];
  draftActions: readonly TemplateReviewActionV2[];
}

export type TemplateReviewResultV2 =
  | {
      cancelled: true;
      draftActions: readonly TemplateReviewActionV2[];
    }
  | {
      cancelled: false;
      actions: readonly TemplateReviewActionV2[];
      confirmedAtLocal: string;
      confirmedBy: "LOCAL_USER";
    };

export type TemplateReviewErrorCodeV2 =
  | "TEMPLATE_REVIEW_INPUT_INVALID"
  | "TEMPLATE_REVIEW_UNSAFE_DOC"
  | "TEMPLATE_REVIEW_UNSAFE_DOCX"
  | "TEMPLATE_REVIEW_CONVERSION_UNAVAILABLE"
  | "TEMPLATE_REVIEW_CONVERSION_FAILED"
  | "TEMPLATE_REVIEW_RENDER_FAILED"
  | "TEMPLATE_REVIEW_PAGE_TOKEN_INVALID"
  | "TEMPLATE_REVIEW_TARGET_NOT_FOUND"
  | "TEMPLATE_REVIEW_RANGE_INVALID"
  | "TEMPLATE_REVIEW_RANGE_OVERLAP"
  | "TEMPLATE_REVIEW_HIGH_RISK_REASON_REQUIRED"
  | "TEMPLATE_REVIEW_SECOND_CONFIRMATION_REQUIRED"
  | "TEMPLATE_REVIEW_PENDING_TARGETS"
  | "TEMPLATE_REVIEW_SOURCE_CHANGED"
  | "TEMPLATE_REVIEW_ABORTED";

export function isValidTemplateReviewTextRangeV2(
  range: TemplateReviewTextRangeV2,
): boolean {
  return (
    Number.isSafeInteger(range.startUtf16) &&
    Number.isSafeInteger(range.endUtf16Exclusive) &&
    range.startUtf16 >= 0 &&
    range.endUtf16Exclusive > range.startUtf16
  );
}

/** ranges 可以相邻，但不允许交叉、包含或重复。 */
export function validateTemplateReviewSplitV2(
  operation: TemplateReviewSplitOperationV2,
): boolean {
  if (!operation.targetId.trim() || operation.ranges.length < 2) return false;
  const ranges = [...operation.ranges].sort(
    (left, right) =>
      left.startUtf16 - right.startUtf16 ||
      left.endUtf16Exclusive - right.endUtf16Exclusive,
  );
  return ranges.every(
    (range, index) =>
      isValidTemplateReviewTextRangeV2(range) &&
      (index === 0 || ranges[index - 1].endUtf16Exclusive <= range.startUtf16),
  );
}
