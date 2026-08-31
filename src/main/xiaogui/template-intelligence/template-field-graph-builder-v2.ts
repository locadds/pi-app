import { createHash } from 'node:crypto'

import type {
  TemplateFieldGraphV2,
  TemplateFieldOccurrenceV2,
  TemplateFieldStructureKindV2,
  TemplateFieldV2,
  TemplateFieldValueTypeV2,
  TemplateIssueV2,
  TemplateRiskFlagV2,
  TemplateSourceAnchorV2,
} from '@shared/xiaogui-template-field-graph-v2'
import {
  TEMPLATE_FIELD_AUTO_ACCEPT_CONFIDENCE_V2,
  TEMPLATE_FIELD_GRAPH_VERSION_V2,
  TEMPLATE_FIELD_REVIEW_CONFIDENCE_V2,
  parseTemplateFieldGraphV2,
} from '@shared/xiaogui-template-field-graph-v2'
import type { TemplateDraftTargetBindingV2 } from '@shared/xiaogui-template-draft-review'
import type {
  TemplateIntakeCandidateV1,
  TemplateIntakeReportV1,
  TemplateIntakeRiskFlagV1,
  TemplateIntakeSourceAnchorV1,
} from '@shared/xiaogui-work-docx-template-intake'
import type { TemplateReviewActionV2 } from '@shared/xiaogui-work-template-review'

export interface TemplateFieldGraphBuildResultV2 {
  fieldGraph: TemplateFieldGraphV2
  targetBindings: readonly TemplateDraftTargetBindingV2[]
  recommendedActions: readonly TemplateReviewActionV2[]
}

type MutableFieldGroup = {
  canonicalKey: string
  displayName: string
  valueType: TemplateFieldValueTypeV2
  structureKind: TemplateFieldStructureKindV2
  confidence: number
  candidates: TemplateIntakeCandidateV1[]
}

const KNOWN_CANONICAL_KEYS: readonly [RegExp, string][] = [
  [/项目名称|工程名称|规划名称/, 'project.name'],
  [/建设单位|项目单位|业主单位/, 'organization.owner'],
  [/编制单位|设计单位|咨询单位/, 'organization.compiler'],
  [/编制日期|编制时间|成文日期/, 'document.prepared_at'],
  [/联系人|项目负责人/, 'contact.person'],
  [/联系电话|手机号码|电话/, 'contact.phone'],
  [/项目地点|建设地点|工程地点|所在位置/, 'project.location'],
  [/项目编号|工程编号|文件编号/, 'project.code'],
]

function hashId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function normalizedText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function normalizedName(name: string): string {
  return normalizedText(name).replace(/[：:。；;，,（）()【】\[\]]/g, '').slice(0, 120)
}

function canonicalKeyFor(name: string): string {
  for (const [pattern, key] of KNOWN_CANONICAL_KEYS) {
    if (pattern.test(name)) return key
  }
  return `custom.${createHash('sha256').update(normalizedName(name)).digest('hex').slice(0, 12)}`
}

function valueTypeFor(name: string, sample: string): TemplateFieldValueTypeV2 {
  if (/日期|时间|年月|期限/.test(name) || /\d{4}\s*年\s*\d{1,2}\s*月/.test(sample)) return 'DATE'
  if (/金额|造价|投资|费用|合同价/.test(name)) return 'MONEY'
  if (/单位|公司|部门|机构/.test(name)) return 'ORGANIZATION'
  if (/姓名|联系人|负责人|编制人|审核人/.test(name)) return 'PERSON'
  if (/地点|位置|地址|区位/.test(name)) return 'LOCATION'
  if (/图片|图件|照片|盖章|印章/.test(name)) return 'IMAGE'
  if (/表格|清单|明细/.test(name)) return 'TABLE'
  if (/数量|长度|宽度|面积|规模|里程|比例|编号/.test(name)) return 'NUMBER'
  return 'TEXT'
}

function structureKindFor(candidate: TemplateIntakeCandidateV1): TemplateFieldStructureKindV2 {
  if (candidate.kind === 'REPEAT') return 'REPEAT'
  if (candidate.kind === 'CONDITIONAL') return 'CONDITIONAL'
  return 'SIMPLE'
}

function sourceAnchorV2(anchor: TemplateIntakeSourceAnchorV1): TemplateSourceAnchorV2 {
  return {
    part: anchor.part === 'TABLE' ? 'TABLE_CELL' : anchor.part,
    ...(anchor.sectionIndex != null ? { sectionIndex: anchor.sectionIndex } : {}),
    ...(anchor.partIndex != null ? { partIndex: anchor.partIndex } : {}),
    ...(anchor.paragraphIndex != null ? { paragraphIndex: anchor.paragraphIndex } : {}),
    ...(anchor.tableIndex != null ? { tableIndex: anchor.tableIndex } : {}),
    ...(anchor.rowIndex != null ? { rowIndex: anchor.rowIndex } : {}),
    ...(anchor.cellIndex != null ? { cellIndex: anchor.cellIndex } : {}),
    ...(anchor.drawingIndex != null ? { drawingIndex: anchor.drawingIndex } : {}),
  }
}

function riskFlagsV2(flags: readonly TemplateIntakeRiskFlagV1[]): TemplateRiskFlagV2[] {
  return flags.map((flag) => flag as TemplateRiskFlagV2)
}

function fieldDisplayName(candidate: TemplateIntakeCandidateV1): string | null {
  const explicit = candidate.suggestedName ? normalizedName(candidate.suggestedName) : ''
  if (explicit) return explicit
  if (candidate.kind === 'REPEAT') return '重复内容'
  if (candidate.kind === 'CONDITIONAL') return '条件内容'
  return null
}

function issue(
  sourceSha256: string,
  input: Omit<TemplateIssueV2, 'issueId' | 'status'>,
): TemplateIssueV2 {
  return {
    ...input,
    issueId: hashId(
      'xgissue2',
      sourceSha256,
      input.kind,
      [...input.fieldIds].sort().join(','),
      [...input.occurrenceIds].sort().join(','),
      input.title,
    ),
    status: 'OPEN',
  }
}

function recommendedAction(
  candidate: TemplateIntakeCandidateV1,
  field: TemplateFieldV2 | undefined,
): TemplateReviewActionV2 {
  if (candidate.riskFlags.length > 0 || candidate.kind === 'EXCLUDE') {
    return { targetId: candidate.candidateId, kind: 'REMOVE' }
  }
  if (field) {
    if (field.structureKind === 'REPEAT') {
      return { targetId: candidate.candidateId, kind: 'REPEAT', blockName: field.displayName }
    }
    if (field.structureKind === 'CONDITIONAL') {
      return { targetId: candidate.candidateId, kind: 'CONDITIONAL', conditionName: field.displayName }
    }
    return { targetId: candidate.candidateId, kind: 'FIELD', fieldName: field.displayName }
  }
  return { targetId: candidate.candidateId, kind: 'KEEP' }
}

export function buildTemplateFieldGraphV2(
  report: TemplateIntakeReportV1,
): TemplateFieldGraphBuildResultV2 {
  const groups = new Map<string, MutableFieldGroup>()
  for (const candidate of report.candidates) {
    if (
      !['VARIABLE', 'REPEAT', 'CONDITIONAL'].includes(candidate.kind) ||
      candidate.riskFlags.length > 0 ||
      candidate.confidence == null ||
      candidate.confidence < TEMPLATE_FIELD_REVIEW_CONFIDENCE_V2
    ) {
      continue
    }
    const name = fieldDisplayName(candidate)
    if (!name) continue
    const structureKind = structureKindFor(candidate)
    const canonicalKey = canonicalKeyFor(name)
    const key = `${structureKind}\0${canonicalKey}`
    const current = groups.get(key)
    if (current) {
      current.confidence = Math.min(current.confidence, candidate.confidence)
      current.candidates.push(candidate)
    } else {
      groups.set(key, {
        canonicalKey,
        displayName: name,
        valueType: valueTypeFor(name, candidate.preview),
        structureKind,
        confidence: candidate.confidence,
        candidates: [candidate],
      })
    }
  }

  const occurrences: TemplateFieldOccurrenceV2[] = []
  const fields: TemplateFieldV2[] = []
  const candidateFieldIds = new Map<string, string>()
  for (const group of [...groups.values()].sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey))) {
    const fieldId = hashId('xgfield2', report.file.sha256, group.canonicalKey, group.structureKind)
    const occurrenceIds: string[] = []
    for (const candidate of group.candidates) {
      candidateFieldIds.set(candidate.candidateId, fieldId)
      const anchors = candidate.sourceAnchors.length ? candidate.sourceAnchors : [{ part: 'BODY' as const }]
      anchors.forEach((anchor, index) => {
        const mappedAnchor = sourceAnchorV2(anchor)
        const occurrenceId = hashId(
          'xgocc2',
          report.file.sha256,
          JSON.stringify(mappedAnchor),
          JSON.stringify(candidate.textRange ?? null),
          String(index),
          normalizedText(candidate.preview),
        )
        occurrenceIds.push(occurrenceId)
        occurrences.push({
          occurrenceId,
          fieldId,
          sourceAnchor: mappedAnchor,
          ...(candidate.textRange ? { textRange: candidate.textRange } : {}),
          originalText: candidate.preview,
          confidence: candidate.confidence ?? 0,
          riskFlags: riskFlagsV2(candidate.riskFlags),
          status: candidate.sourceAnchors.length ? 'MAPPED' : 'UNMAPPED',
        })
      })
    }
    fields.push({
      fieldId,
      canonicalKey: group.canonicalKey,
      displayName: group.displayName,
      valueType: group.valueType,
      structureKind: group.structureKind,
      required: group.structureKind === 'SIMPLE',
      sampleValue: group.candidates[0]?.preview,
      aliases: [],
      occurrenceIds,
      confidence: group.confidence,
      status: group.confidence >= TEMPLATE_FIELD_AUTO_ACCEPT_CONFIDENCE_V2
        ? 'AUTO_ACCEPTED'
        : 'NEEDS_REVIEW',
    })
  }

  const riskOccurrenceIdsByCandidate = new Map<string, string[]>()
  for (const candidate of report.candidates) {
    if (candidate.riskFlags.length === 0) continue
    const ids: string[] = []
    for (const [index, anchor] of candidate.sourceAnchors.entries()) {
      if (anchor.part === 'DRAWING' || anchor.part === 'TEXT_BOX') continue
      const mappedAnchor = sourceAnchorV2(anchor)
      const occurrenceId = hashId(
        'xgriskocc2',
        report.file.sha256,
        JSON.stringify(mappedAnchor),
        JSON.stringify(candidate.textRange ?? null),
        String(index),
        normalizedText(candidate.preview),
      )
      ids.push(occurrenceId)
      occurrences.push({
        occurrenceId,
        fieldId: `risk.${candidate.riskFlags[0].toLowerCase()}`,
        sourceAnchor: mappedAnchor,
        ...(candidate.textRange ? { textRange: candidate.textRange } : {}),
        originalText: candidate.preview,
        confidence: candidate.confidence ?? 0,
        riskFlags: riskFlagsV2(candidate.riskFlags),
        status: 'MAPPED',
      })
    }
    if (ids.length) riskOccurrenceIdsByCandidate.set(candidate.candidateId, ids)
  }

  const issues: TemplateIssueV2[] = []
  for (const field of fields) {
    if (field.status !== 'NEEDS_REVIEW') continue
    issues.push(issue(report.file.sha256, {
      kind: field.structureKind === 'SIMPLE' ? 'FIELD_AMBIGUOUS' : 'STRUCTURE_AMBIGUOUS',
      severity: 'WARNING',
      title: `确认“${field.displayName}”`,
      question: `小规识别到 ${field.occurrenceIds.length} 处可能属于“${field.displayName}”。是否作为同一业务字段处理？`,
      fieldIds: [field.fieldId],
      occurrenceIds: field.occurrenceIds,
      suggestedActions: ['ACCEPT_SUGGESTION', 'KEEP_ORIGINAL', 'OPEN_ADVANCED_REVIEW'],
    }))
  }

  const highRiskByFlag = new Map<TemplateIntakeRiskFlagV1, TemplateIntakeCandidateV1[]>()
  for (const candidate of report.candidates) {
    for (const flag of candidate.riskFlags) {
      const list = highRiskByFlag.get(flag) ?? []
      list.push(candidate)
      highRiskByFlag.set(flag, list)
    }
  }
  const riskLabels: Record<TemplateIntakeRiskFlagV1, string> = {
    SIGNATURE: '签字内容',
    SEAL: '印章内容',
    CONTACT_INFORMATION: '联系方式',
    OLD_PROJECT_DRAWING: '旧项目图件',
    SCANNED_ATTACHMENT: '扫描附件',
    FLOATING_OBJECT: '浮动对象',
    TEXT_BOX: '文本框',
    OTHER: '高风险内容',
  }
  for (const [flag, candidates] of highRiskByFlag) {
    const occurrenceIds = candidates.flatMap(
      (candidate) => riskOccurrenceIdsByCandidate.get(candidate.candidateId) ?? [],
    )
    issues.push(issue(report.file.sha256, {
      kind: ['FLOATING_OBJECT', 'TEXT_BOX'].includes(flag) ? 'UNSUPPORTED_OBJECT' : 'HIGH_RISK_CONTENT',
      severity: 'BLOCKING',
      title: `处理${riskLabels[flag]}`,
      question: `发现 ${candidates.length} 处${riskLabels[flag]}。默认不继承到新模板，请确认全部移除、保留，或进入高级检查逐处处理。`,
      fieldIds: [],
      occurrenceIds,
      suggestedActions: ['REMOVE_CONTENT', 'KEEP_ORIGINAL', 'OPEN_ADVANCED_REVIEW'],
    }))
  }

  const modelFailure = report.warnings.some((warning) =>
    ['MODEL_UNAVAILABLE', 'MODEL_OUTPUT_INVALID', 'ANALYSIS_LIMIT_EXCEEDED'].includes(warning.code),
  )
  if (modelFailure) {
    issues.push(issue(report.file.sha256, {
      kind: 'VALIDATION_FAILED',
      severity: 'BLOCKING',
      title: '业务字段识别未完成',
      question: '本次模型分析没有完整成功。小规已保留全部原文，但不能把“没有识别到字段”当成可用模板；请重试分析或进入高级检查。',
      fieldIds: [],
      occurrenceIds: [],
      suggestedActions: ['RETRY_ANALYSIS', 'OPEN_ADVANCED_REVIEW'],
    }))
  }

  const issueIdsByTarget = new Map<string, string[]>()
  for (const issueItem of issues) {
    const occurrenceSet = new Set(issueItem.occurrenceIds)
    const issueFieldSet = new Set(issueItem.fieldIds)
    for (const candidate of report.candidates) {
      const fieldId = candidateFieldIds.get(candidate.candidateId)
      const field = fieldId ? fields.find((item) => item.fieldId === fieldId) : undefined
      const isRiskMatch = issueItem.kind === 'HIGH_RISK_CONTENT' || issueItem.kind === 'UNSUPPORTED_OBJECT'
        ? candidate.riskFlags.some((flag) => issueItem.title.includes(riskLabels[flag]))
        : false
      const fieldMatch = !!fieldId && issueFieldSet.has(fieldId) && field?.occurrenceIds.some((id) => occurrenceSet.has(id))
      if (!fieldMatch && !isRiskMatch) continue
      const list = issueIdsByTarget.get(candidate.candidateId) ?? []
      list.push(issueItem.issueId)
      issueIdsByTarget.set(candidate.candidateId, list)
    }
  }

  const targetBindings: TemplateDraftTargetBindingV2[] = report.candidates.map((candidate) => {
    const fieldId = candidateFieldIds.get(candidate.candidateId)
    const field = fieldId ? fields.find((item) => item.fieldId === fieldId) : undefined
    return {
      targetId: candidate.candidateId,
      ...(fieldId ? { fieldId } : {}),
      issueIds: issueIdsByTarget.get(candidate.candidateId) ?? [],
      recommendedAction: recommendedAction(candidate, field),
    }
  })
  const now = report.updatedAt
  const fieldGraph = parseTemplateFieldGraphV2({
    graphVersion: TEMPLATE_FIELD_GRAPH_VERSION_V2,
    graphId: hashId('xggraph2', report.file.sha256, report.versions.rules, report.versions.model ?? 'none'),
    source: report.file,
    fields,
    occurrences,
    issues,
    analysisEvidenceId: hashId('xgevidence2', report.file.sha256, report.reportId),
    createdAt: report.createdAt,
    updatedAt: now,
  })
  return {
    fieldGraph,
    targetBindings,
    recommendedActions: targetBindings.map((binding) => binding.recommendedAction),
  }
}
