import { describe, expect, it } from 'vitest'

import type {
  TemplateIntakeCandidateV1,
  TemplateIntakeReportV1,
} from '@shared/xiaogui-work-docx-template-intake'
import { buildTemplateFieldGraphV2 } from './template-field-graph-builder-v2'

const SOURCE_SHA = 'a'.repeat(64)

function candidate(
  id: string,
  overrides: Partial<TemplateIntakeCandidateV1> = {},
): TemplateIntakeCandidateV1 {
  return {
    candidateId: id,
    kind: 'FIXED',
    preview: '普通规划正文保持原样',
    sourceAnchors: [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 1 }],
    reason: '普通正文',
    confidence: 0.98,
    riskFlags: [],
    defaultDecision: 'FIXED',
    ...overrides,
  }
}

function report(candidates: readonly TemplateIntakeCandidateV1[], warnings: TemplateIntakeReportV1['warnings'] = []): TemplateIntakeReportV1 {
  return {
    reportVersion: 1,
    reportId: 'report-v2-test',
    status: 'DRAFT',
    file: { displayName: '规划方案.docx', sha256: SOURCE_SHA, byteLength: 100 },
    profile: {
      pageCount: { value: null, basis: 'UNKNOWN' },
      sectionCount: 1,
      headerPartCount: 0,
      footerPartCount: 0,
      tableCount: 0,
      mediaCount: 0,
      inlineDrawingCount: 0,
      floatingDrawingCount: 0,
      textBoxCount: 0,
      fieldCount: 0,
      contentControlCount: 0,
      scannedPageCount: null,
    },
    versions: {
      safetyGate: 'safety-v1',
      structureParser: 'structure-v1',
      semanticParser: 'semantic-v1',
      rules: 'rules-v1',
      model: 'provider/model',
    },
    warnings,
    candidates,
    requiresHumanConfirmation: true,
    canMaterializeTemplate: false,
    createdAt: '2026-08-29T10:00:00+08:00',
    updatedAt: '2026-08-29T10:01:00+08:00',
  }
}

describe('buildTemplateFieldGraphV2', () => {
  it('按业务字段合并多个位置，未识别正文默认保留且不生成问题', () => {
    const input = report([
      candidate('fixed'),
      candidate('unresolved', {
        kind: 'UNRESOLVED',
        defaultDecision: 'UNRESOLVED',
        confidence: null,
        reason: '模型未给出建议',
      }),
      candidate('project-title', {
        kind: 'VARIABLE',
        defaultDecision: 'VARIABLE',
        preview: '临港新片区道路工程',
        suggestedName: '项目名称',
        confidence: 0.96,
        sourceAnchors: [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 2 }],
      }),
      candidate('project-header', {
        kind: 'VARIABLE',
        defaultDecision: 'VARIABLE',
        preview: '临港新片区道路工程',
        suggestedName: '工程名称',
        confidence: 0.93,
        sourceAnchors: [{ part: 'HEADER', partIndex: 1, paragraphIndex: 1 }],
      }),
    ])

    const result = buildTemplateFieldGraphV2(input)

    expect(result.fieldGraph.fields).toHaveLength(1)
    expect(result.fieldGraph.fields[0]).toMatchObject({
      canonicalKey: 'project.name',
      occurrenceIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
      status: 'AUTO_ACCEPTED',
    })
    expect(result.fieldGraph.occurrences).toHaveLength(2)
    expect(result.fieldGraph.issues).toHaveLength(0)
    expect(result.targetBindings.find((item) => item.targetId === 'fixed')?.recommendedAction.kind).toBe('KEEP')
    expect(result.targetBindings.find((item) => item.targetId === 'unresolved')?.recommendedAction.kind).toBe('KEEP')
  })

  it('把高风险位置合并为一个业务问题，不把每个段落分别暴露给默认界面', () => {
    const result = buildTemplateFieldGraphV2(report([
      candidate('phone-1', {
        kind: 'EXCLUDE',
        defaultDecision: 'EXCLUDE',
        preview: '联系电话：13800000000',
        riskFlags: ['CONTACT_INFORMATION'],
        confidence: 1,
      }),
      candidate('phone-2', {
        kind: 'EXCLUDE',
        defaultDecision: 'EXCLUDE',
        preview: '联系人电话：021-12345678',
        riskFlags: ['CONTACT_INFORMATION'],
        confidence: 1,
        sourceAnchors: [{ part: 'BODY', sectionIndex: 1, paragraphIndex: 2 }],
      }),
    ]))

    expect(result.fieldGraph.issues).toHaveLength(2)
    const risk = result.fieldGraph.issues.find((item) => item.kind === 'HIGH_RISK_CONTENT')
    expect(risk?.question).toContain('2 处联系方式')
    expect(result.targetBindings.filter((item) => item.issueIds.includes(risk!.issueId))).toHaveLength(2)
  })

  it('模型失败只生成一个明确阻断问题，而不是把全文变成黄色候选', () => {
    const result = buildTemplateFieldGraphV2(report([
      candidate('paragraph-1', { kind: 'UNRESOLVED', defaultDecision: 'UNRESOLVED', confidence: null }),
      candidate('paragraph-2', { kind: 'UNRESOLVED', defaultDecision: 'UNRESOLVED', confidence: null }),
    ], [{ code: 'MODEL_OUTPUT_INVALID', message: '模型输出无效' }]))

    expect(result.fieldGraph.fields).toHaveLength(0)
    expect(result.fieldGraph.issues).toHaveLength(1)
    expect(result.fieldGraph.issues[0]).toMatchObject({
      kind: 'VALIDATION_FAILED',
      severity: 'BLOCKING',
    })
    expect(result.recommendedActions.map((action) => action.kind)).toEqual(['KEEP', 'KEEP'])
  })

  it('稳定字段与位置编号不依赖随机 Candidate 编号', () => {
    const first = buildTemplateFieldGraphV2(report([
      candidate('random-a', {
        kind: 'VARIABLE',
        defaultDecision: 'VARIABLE',
        preview: '2026年8月',
        suggestedName: '编制日期',
        confidence: 0.95,
      }),
    ]))
    const second = buildTemplateFieldGraphV2(report([
      candidate('random-b', {
        kind: 'VARIABLE',
        defaultDecision: 'VARIABLE',
        preview: '2026年8月',
        suggestedName: '编制日期',
        confidence: 0.95,
      }),
    ]))

    expect(second.fieldGraph.fields[0].fieldId).toBe(first.fieldGraph.fields[0].fieldId)
    expect(second.fieldGraph.occurrences[0].occurrenceId).toBe(first.fieldGraph.occurrences[0].occurrenceId)
  })
})

