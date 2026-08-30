import type { ModeRecommendationV1 } from '@shared/xiaogui-mode-recommendation'
import type { XiaoguiMode } from '@shared/xiaogui-prompt-contract'

export interface ModeRecommendationInputV1 {
  readonly currentMode: XiaoguiMode
  readonly text: string
  readonly attachmentNames?: readonly string[]
}

type SignalRule = {
  readonly category: string
  readonly pattern: RegExp
}

const LOCAL_RECOMMENDATION_POLICY_V1 = {
  minimumTextLength: 8,
  minimumTextSignals: 2,
  highConfidenceTextSignals: 3,
  minimumSignalLead: 2,
} as const

const MODE_SIGNAL_RULES: Readonly<Record<XiaoguiMode, readonly SignalRule[]>> = {
  WORK: [
    { category: 'DOCUMENT_FORMAT', pattern: /Word|DOCX|成品文档/i },
    { category: 'REPORT_DELIVERABLE', pattern: /报告|模板/i },
    { category: 'TEMPLATE_CONVERSION', pattern: /整理(?:成|为).{0,4}模板|模板整理/i },
    { category: 'FILE_ORGANIZATION', pattern: /整理文件|资料清单/i },
    { category: 'CONTENT_EDITING', pattern: /改写|总结/i },
    { category: 'TABLE_WORK', pattern: /表格/i },
  ],
  DESIGN: [
    { category: 'SPATIAL_SOFTWARE', pattern: /GIS|CAD/i },
    { category: 'SPATIAL_ANALYSIS', pattern: /空间分析|缓冲区|可达性/i },
    { category: 'SITE_PLANNING', pattern: /选址|布局|规划方案/i },
    { category: 'INFRASTRUCTURE_DRAWING', pattern: /道路断面|管线/i },
    { category: 'COORDINATE_LAYER', pattern: /坐标|图层/i },
  ],
  CODING: [
    { category: 'CODE_CHANGE', pattern: /代码|bug|报错|重构/i },
    { category: 'REPOSITORY_WORKFLOW', pattern: /仓库|\bPR\b|commit/i },
    { category: 'TEST_BUILD', pattern: /测试|构建/i },
    { category: 'PROGRAMMING_LANGUAGE', pattern: /TypeScript|Python/i },
    { category: 'API_DEVELOPMENT', pattern: /\bAPI\b/i },
  ],
}

const MODE_ATTACHMENT_RULES: Readonly<
  Record<XiaoguiMode, { readonly category: string; readonly extensions: ReadonlySet<string> }>
> = {
  WORK: {
    category: 'DOCUMENT_ATTACHMENT',
    extensions: new Set(['doc', 'docx', 'pdf', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'md', 'txt']),
  },
  DESIGN: {
    category: 'SPATIAL_ATTACHMENT',
    extensions: new Set(['dwg', 'dxf', 'shp', 'geojson', 'gpkg', 'kml', 'kmz']),
  },
  CODING: {
    category: 'CODE_ATTACHMENT',
    extensions: new Set([
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'cpp',
      'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'sh', 'sql', 'vue', 'svelte',
    ]),
  },
}

const MODE_REASON: Readonly<
  Record<
    XiaoguiMode,
    Pick<ModeRecommendationV1, 'reasonCode' | 'reasonText'>
  >
> = {
  WORK: {
    reasonCode: 'DOCUMENT_WORK_TASK',
    reasonText: '检测到文档交付与资料整理等组合信号。',
  },
  DESIGN: {
    reasonCode: 'PLANNING_SPATIAL_TASK',
    reasonText: '检测到规划设计与空间分析等组合信号。',
  },
  CODING: {
    reasonCode: 'CODE_REPOSITORY_TASK',
    reasonText: '检测到代码维护、仓库或测试构建等组合信号。',
  },
}

const EMBEDDED_CODE_REFERENCE = /(?:报告|文档)(?:中|里).{0,24}(?:Python|TypeScript|代码)/i
const CODING_ACTION = /修复|调试|开发|编写|实现|重构|测试|构建|报错|bug|仓库|提交|\bPR\b|commit|\bAPI\b/i
const MODE_SWITCH_OPT_OUT = /(?:不要|不需|不用|不必).{0,8}(?:切换|换).{0,4}模式|别.{0,4}(?:切换|换)(?:.{0,4}模式)?|保持.{0,8}(?:当前|现有).{0,4}模式/i

function matchedTextSignals(mode: XiaoguiMode, text: string): string[] {
  if (mode === 'CODING' && EMBEDDED_CODE_REFERENCE.test(text) && !CODING_ACTION.test(text)) {
    return []
  }
  return MODE_SIGNAL_RULES[mode]
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.category)
}

function matchedAttachmentSignals(mode: XiaoguiMode, names: readonly string[]): string[] {
  const rule = MODE_ATTACHMENT_RULES[mode]
  return names.some((name) => {
    const extension = name.split('.').pop()?.toLowerCase()
    return extension ? rule.extensions.has(extension) : false
  })
    ? [rule.category]
    : []
}

export function recommendXiaoguiModeV1(
  input: ModeRecommendationInputV1,
): ModeRecommendationV1 | null {
  const text = input.text.trim()
  if (text.length < LOCAL_RECOMMENDATION_POLICY_V1.minimumTextLength || MODE_SWITCH_OPT_OUT.test(text)) {
    return null
  }

  const scores = (Object.keys(MODE_SIGNAL_RULES) as XiaoguiMode[]).map((mode) => ({
    mode,
    matchedSignals: matchedTextSignals(mode, text),
  }))
  if (
    scores.filter(
      (entry) => entry.matchedSignals.length >= LOCAL_RECOMMENDATION_POLICY_V1.minimumTextSignals,
    ).length > 1
  ) {
    return null
  }
  const currentScore = scores.find((entry) => entry.mode === input.currentMode)?.matchedSignals.length ?? 0
  const candidates = scores
    .filter((entry) => entry.mode !== input.currentMode)
    .sort((a, b) => b.matchedSignals.length - a.matchedSignals.length)
  const winner = candidates[0]
  if (
    !winner ||
    winner.matchedSignals.length < LOCAL_RECOMMENDATION_POLICY_V1.minimumTextSignals ||
    winner.matchedSignals.length - currentScore < LOCAL_RECOMMENDATION_POLICY_V1.minimumSignalLead ||
    winner.matchedSignals.length === candidates[1]?.matchedSignals.length
  ) {
    return null
  }
  const reason = MODE_REASON[winner.mode]
  const matchedSignals = [
    ...winner.matchedSignals,
    ...matchedAttachmentSignals(winner.mode, input.attachmentNames ?? []),
  ]

  return {
    schemaVersion: 1,
    currentMode: input.currentMode,
    recommendedMode: winner.mode,
    confidence:
      winner.matchedSignals.length >= LOCAL_RECOMMENDATION_POLICY_V1.highConfidenceTextSignals
        ? 'HIGH'
        : 'MEDIUM',
    ...reason,
    matchedSignals,
  }
}
