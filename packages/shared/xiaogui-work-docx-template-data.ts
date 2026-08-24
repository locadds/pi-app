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
  name: string
  required: true
  occurrences: number
  locations: readonly WorkDocxTemplateFieldLocationV1[]
}

export type WorkDocxTemplateFieldInputV1 =
  | {
      name: string
      status: 'READY'
      value: string | number | boolean
      sourceSummary?: string
    }
  | {
      name: string
      status: 'UNRESOLVED'
      sourceSummary?: string
    }
