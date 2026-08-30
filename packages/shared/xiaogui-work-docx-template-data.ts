export type WorkDocxTemplateFieldLocationV1 = '正文' | '页眉' | '页脚' | '未知'

export interface WorkDocxTemplateProfileV1 {
  bodyPartCount: 1
  sectionCount: number
  headerPartCount: number
  footerPartCount: number
  inlineDrawingCount: number
  floatingDrawingCount: number
  mediaCount: number
  fieldCount: number
}

export interface WorkDocxTemplateFieldV1 {
  /** 模板版本内稳定编号；生成时以它为准，中文名称仅用于展示。 */
  fieldId: string
  name: string
  required: boolean
  occurrences: number
  locations: readonly WorkDocxTemplateFieldLocationV1[]
}

export type WorkDocxTemplateFieldInputV1 =
  | {
      fieldId: string
      name: string
      status: 'READY'
      value: string | number | boolean
      sourceSummary?: string
    }
  | {
      fieldId: string
      name: string
      status: 'UNRESOLVED'
      sourceSummary?: string
    }
