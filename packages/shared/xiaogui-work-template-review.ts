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

export interface TemplateReviewIssueChoiceV2 {
  issueId: string;
  action:
    | "ACCEPT_SUGGESTION"
    | "KEEP_ORIGINAL"
    | "REMOVE_CONTENT"
    | "OPEN_ADVANCED_REVIEW"
    | "RETRY_ANALYSIS";
  reason?: string;
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
      issueChoicesV2?: readonly TemplateReviewIssueChoiceV2[];
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

/**
 * WORK 内置文档复核器 V3：直接把受控 DOCX 副本交给可信 Renderer 渲染。
 *
 * V2 继续保留用于读取既有草稿；V3 复用同一组人工决定语义，但不再包含
 * PDF 页面令牌或坐标。文档令牌和书签名都是短期、不透明、无路径的显示信息。
 */
export const TEMPLATE_REVIEW_VERSION_V3 = 3 as const;

export type TemplateReviewRenderModeV3 =
  | "DOCX_HTML"
  | "STRUCTURED_FALLBACK";

export type TemplateReviewPaginationBasisV3 =
  | "DOCX_STORED_BREAKS"
  | "UNKNOWN";

export type TemplateReviewDocumentTokenV3 = string;

export type TemplateReviewRenderWarningCodeV3 =
  | "LEGACY_DOC_CONVERSION_UNAVAILABLE"
  | "LEGACY_DOC_CONVERSION_FAILED"
  | "DOCX_HTML_PAGINATION_APPROXIMATE"
  | "DOCX_HTML_RENDER_FAILED"
  | "TARGET_MARKER_MISSING"
  | "TARGET_TEXT_MISMATCH"
  | "TARGET_OBJECT_UNSUPPORTED"
  | "TARGET_LOCATION_UNMAPPED"
  | "STRUCTURED_FALLBACK_ACTIVE"
  | "OTHER";

export interface TemplateReviewRenderWarningV3 {
  code: TemplateReviewRenderWarningCodeV3;
  message: string;
  targetIds?: readonly string[];
}

export interface TemplateReviewRenderV3 {
  mode: TemplateReviewRenderModeV3;
  /** DOCX_HTML 时必有；STRUCTURED_FALLBACK 时不得提供。 */
  documentToken?: TemplateReviewDocumentTokenV3;
  paginationBasis: TemplateReviewPaginationBasisV3;
  /** HTML 视图只能表达近似页面，不冒充 Word 实际页数。 */
  approximatePageCount: number | null;
  warnings: readonly TemplateReviewRenderWarningV3[];
}

export interface TemplateReviewDocumentV3 {
  reviewVersion: typeof TEMPLATE_REVIEW_VERSION_V3;
  reviewId: string;
  status: TemplateReviewDocumentStatusV2;
  source: TemplateReviewDocumentV2["source"];
  render: TemplateReviewRenderV3;
  targetCount: number;
  pendingTargetCount: number;
  resolvedTargetCount: number;
  unmappedTargetCount: number;
  requiresHumanConfirmation: true;
  sourceReadOnly: true;
  createdAt: string;
  updatedAt: string;
}

export type TemplateReviewProjectionStatusV3 = "PROJECTED" | "UNMAPPED";

export interface TemplateReviewRenderAnchorV3 {
  status: TemplateReviewProjectionStatusV3;
  /** docx-preview 渲染出的零长度书签；仅 PROJECTED 时存在。 */
  startBookmark?: string;
  endBookmark?: string;
  /** 仅简单文字目标允许把 DOM 选区换算为源 DOCX UTF-16 范围。 */
  textSelectionAllowed: boolean;
  /** 仅主进程已按 DrawingML 顺序确认的行内对象允许在文档中点击复核。 */
  objectSelectionAllowed?: boolean;
  expectedTextSha256?: string;
  expectedTextLengthUtf16?: number;
  /** 仅用于容忍 DOCX 渲染器添加的视觉空白；命中时仍禁止局部拆分。 */
  expectedCompactTextSha256?: string;
  expectedCompactTextLengthUtf16?: number;
}

export interface TemplateReviewTargetV3
  extends Omit<TemplateReviewTargetV2, "pageRegions"> {
  renderAnchor: TemplateReviewRenderAnchorV3;
}

/** V3 只替换显示契约；人工决定的含义和持久化格式保持 V2 兼容。 */
export type TemplateReviewActionV3 = TemplateReviewActionV2;
export type TemplateReviewResultV3 = TemplateReviewResultV2;

export interface TemplateReviewRequestV3 {
  reviewVersion: typeof TEMPLATE_REVIEW_VERSION_V3;
  document: TemplateReviewDocumentV3;
  targets: readonly TemplateReviewTargetV3[];
  draftActions: readonly TemplateReviewActionV3[];
}

export type TemplateReviewErrorCodeV3 =
  | Exclude<TemplateReviewErrorCodeV2, "TEMPLATE_REVIEW_PAGE_TOKEN_INVALID">
  | "TEMPLATE_REVIEW_DOCUMENT_TOKEN_INVALID"
  | "TEMPLATE_REVIEW_PROJECTION_FAILED";
