import { z } from 'zod'

/**
 * 模板资产化 V2 的业务语义契约。
 *
 * Candidate/V1 仍作为后台证据和高级检查契约保留；普通用户默认只消费
 * Field Graph 与 Issue。该对象不得包含源文件路径、完整 OOXML 或模型原始回答。
 */

export const TEMPLATE_FIELD_GRAPH_VERSION_V2 = 2 as const
export const TEMPLATE_FIELD_AUTO_ACCEPT_CONFIDENCE_V2 = 0.9 as const
export const TEMPLATE_FIELD_REVIEW_CONFIDENCE_V2 = 0.6 as const
export const TEMPLATE_FIELD_QUICK_ISSUE_TARGET_V2 = 15 as const

export type TemplateFieldValueTypeV2 =
  | 'TEXT'
  | 'DATE'
  | 'NUMBER'
  | 'MONEY'
  | 'ORGANIZATION'
  | 'PERSON'
  | 'LOCATION'
  | 'IMAGE'
  | 'TABLE'

export type TemplateFieldStructureKindV2 = 'SIMPLE' | 'REPEAT' | 'CONDITIONAL'

export type TemplateFieldStatusV2 =
  | 'AUTO_ACCEPTED'
  | 'NEEDS_REVIEW'
  | 'CONFIRMED'
  | 'REMOVED'

export type TemplateOccurrenceStatusV2 = 'MAPPED' | 'PARTIAL' | 'UNMAPPED'

export type TemplateSourcePartV2 =
  | 'BODY'
  | 'HEADER'
  | 'FOOTER'
  | 'TABLE_CELL'
  | 'TEXT_BOX'
  | 'DRAWING'

export interface TemplateSourceAnchorV2 {
  part: TemplateSourcePartV2
  sectionIndex?: number
  partIndex?: number
  paragraphIndex?: number
  tableIndex?: number
  rowIndex?: number
  cellIndex?: number
  drawingIndex?: number
}

export type TemplateRiskFlagV2 =
  | 'SIGNATURE'
  | 'SEAL'
  | 'CONTACT_INFORMATION'
  | 'OLD_PROJECT_DRAWING'
  | 'SCANNED_ATTACHMENT'
  | 'FLOATING_OBJECT'
  | 'TEXT_BOX'
  | 'PARSER_EXCEPTION'
  | 'OTHER'

export interface TemplateFieldV2 {
  fieldId: string
  canonicalKey: string
  displayName: string
  valueType: TemplateFieldValueTypeV2
  structureKind: TemplateFieldStructureKindV2
  required: boolean
  sampleValue?: string
  defaultValue?: string
  aliases: readonly string[]
  occurrenceIds: readonly string[]
  confidence: number
  status: TemplateFieldStatusV2
}

export interface TemplateFieldOccurrenceV2 {
  occurrenceId: string
  fieldId: string
  sourceAnchor: TemplateSourceAnchorV2
  textRange?: {
    startUtf16: number
    endUtf16Exclusive: number
  }
  originalText: string
  contextBefore?: string
  contextAfter?: string
  formatFingerprint?: string
  semanticRole?: string
  confidence: number
  riskFlags: readonly TemplateRiskFlagV2[]
  status: TemplateOccurrenceStatusV2
}

export type TemplateIssueKindV2 =
  | 'FIELD_AMBIGUOUS'
  | 'FIELD_BOUNDARY_AMBIGUOUS'
  | 'DUPLICATE_VALUE_CONFLICT'
  | 'POSSIBLE_WRONG_MERGE'
  | 'HIGH_RISK_CONTENT'
  | 'UNSUPPORTED_OBJECT'
  | 'STRUCTURE_AMBIGUOUS'
  | 'SOURCE_CHANGED'
  | 'VALIDATION_FAILED'

export type TemplateIssueActionV2 =
  | 'ACCEPT_SUGGESTION'
  | 'KEEP_ORIGINAL'
  | 'REMOVE_CONTENT'
  | 'OPEN_ADVANCED_REVIEW'
  | 'RETRY_ANALYSIS'

export interface TemplateIssueResolutionV2 {
  action: TemplateIssueActionV2
  reason?: string
  resolvedAtLocal: string
  resolvedBy: 'LOCAL_USER'
}

export interface TemplateIssueV2 {
  issueId: string
  kind: TemplateIssueKindV2
  severity: 'INFO' | 'WARNING' | 'BLOCKING'
  title: string
  question: string
  fieldIds: readonly string[]
  occurrenceIds: readonly string[]
  suggestedActions: readonly TemplateIssueActionV2[]
  status: 'OPEN' | 'RESOLVED' | 'DEFERRED'
  resolution?: TemplateIssueResolutionV2
}

export interface TemplateFieldGraphV2 {
  graphVersion: typeof TEMPLATE_FIELD_GRAPH_VERSION_V2
  graphId: string
  source: {
    displayName: string
    sha256: string
    byteLength: number
  }
  fields: readonly TemplateFieldV2[]
  occurrences: readonly TemplateFieldOccurrenceV2[]
  issues: readonly TemplateIssueV2[]
  analysisEvidenceId: string
  createdAt: string
  updatedAt: string
}

const SourceAnchorSchema = z.object({
  part: z.enum(['BODY', 'HEADER', 'FOOTER', 'TABLE_CELL', 'TEXT_BOX', 'DRAWING']),
  sectionIndex: z.number().int().positive().optional(),
  partIndex: z.number().int().positive().optional(),
  paragraphIndex: z.number().int().positive().optional(),
  tableIndex: z.number().int().positive().optional(),
  rowIndex: z.number().int().positive().optional(),
  cellIndex: z.number().int().positive().optional(),
  drawingIndex: z.number().int().positive().optional(),
}).strict()

const RiskFlagSchema = z.enum([
  'SIGNATURE',
  'SEAL',
  'CONTACT_INFORMATION',
  'OLD_PROJECT_DRAWING',
  'SCANNED_ATTACHMENT',
  'FLOATING_OBJECT',
  'TEXT_BOX',
  'PARSER_EXCEPTION',
  'OTHER',
])

export const TemplateFieldGraphV2Schema = z.object({
  graphVersion: z.literal(TEMPLATE_FIELD_GRAPH_VERSION_V2),
  graphId: z.string().min(1).max(160),
  source: z.object({
    displayName: z.string().min(1).max(160),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
  }).strict(),
  fields: z.array(z.object({
    fieldId: z.string().min(1).max(160),
    canonicalKey: z.string().min(1).max(200),
    displayName: z.string().min(1).max(120),
    valueType: z.enum(['TEXT', 'DATE', 'NUMBER', 'MONEY', 'ORGANIZATION', 'PERSON', 'LOCATION', 'IMAGE', 'TABLE']),
    structureKind: z.enum(['SIMPLE', 'REPEAT', 'CONDITIONAL']),
    required: z.boolean(),
    sampleValue: z.string().max(500).optional(),
    defaultValue: z.string().max(500).optional(),
    aliases: z.array(z.string().min(1).max(120)).max(50),
    occurrenceIds: z.array(z.string().min(1).max(160)).max(2_000),
    confidence: z.number().min(0).max(1),
    status: z.enum(['AUTO_ACCEPTED', 'NEEDS_REVIEW', 'CONFIRMED', 'REMOVED']),
  }).strict()).max(500),
  occurrences: z.array(z.object({
    occurrenceId: z.string().min(1).max(160),
    fieldId: z.string().min(1).max(160),
    sourceAnchor: SourceAnchorSchema,
    textRange: z.object({
      startUtf16: z.number().int().nonnegative(),
      endUtf16Exclusive: z.number().int().positive(),
    }).strict().refine((range) => range.endUtf16Exclusive > range.startUtf16).optional(),
    originalText: z.string().max(500),
    contextBefore: z.string().max(500).optional(),
    contextAfter: z.string().max(500).optional(),
    formatFingerprint: z.string().max(200).optional(),
    semanticRole: z.string().max(200).optional(),
    confidence: z.number().min(0).max(1),
    riskFlags: z.array(RiskFlagSchema).max(20),
    status: z.enum(['MAPPED', 'PARTIAL', 'UNMAPPED']),
  }).strict()).max(2_000),
  issues: z.array(z.object({
    issueId: z.string().min(1).max(160),
    kind: z.enum([
      'FIELD_AMBIGUOUS',
      'FIELD_BOUNDARY_AMBIGUOUS',
      'DUPLICATE_VALUE_CONFLICT',
      'POSSIBLE_WRONG_MERGE',
      'HIGH_RISK_CONTENT',
      'UNSUPPORTED_OBJECT',
      'STRUCTURE_AMBIGUOUS',
      'SOURCE_CHANGED',
      'VALIDATION_FAILED',
    ]),
    severity: z.enum(['INFO', 'WARNING', 'BLOCKING']),
    title: z.string().min(1).max(200),
    question: z.string().min(1).max(1_000),
    fieldIds: z.array(z.string().min(1).max(160)).max(500),
    occurrenceIds: z.array(z.string().min(1).max(160)).max(2_000),
    suggestedActions: z.array(z.enum([
      'ACCEPT_SUGGESTION',
      'KEEP_ORIGINAL',
      'REMOVE_CONTENT',
      'OPEN_ADVANCED_REVIEW',
      'RETRY_ANALYSIS',
    ])).min(1).max(5),
    status: z.enum(['OPEN', 'RESOLVED', 'DEFERRED']),
    resolution: z.object({
      action: z.enum([
        'ACCEPT_SUGGESTION',
        'KEEP_ORIGINAL',
        'REMOVE_CONTENT',
        'OPEN_ADVANCED_REVIEW',
        'RETRY_ANALYSIS',
      ]),
      reason: z.string().min(1).max(1_000).optional(),
      resolvedAtLocal: z.string().min(1).max(80),
      resolvedBy: z.literal('LOCAL_USER'),
    }).strict().optional(),
  }).strict()).max(500),
  analysisEvidenceId: z.string().min(1).max(160),
  createdAt: z.string().min(1).max(80),
  updatedAt: z.string().min(1).max(80),
}).strict()

export function parseTemplateFieldGraphV2(value: unknown): TemplateFieldGraphV2 {
  return TemplateFieldGraphV2Schema.parse(value) as TemplateFieldGraphV2
}
