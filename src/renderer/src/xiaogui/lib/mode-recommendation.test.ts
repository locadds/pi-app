import { describe, expect, it } from 'vitest'

import { recommendXiaoguiModeV1 } from './mode-recommendation'

describe('recommendXiaoguiModeV1', () => {
  it('recommends CODING only when a code task has combined evidence', () => {
    expect(
      recommendXiaoguiModeV1({
        currentMode: 'WORK',
        text: '请修复仓库里的 TypeScript 构建报错，并补上单元测试后提交 PR',
      }),
    ).toMatchObject({
      schemaVersion: 1,
      currentMode: 'WORK',
      recommendedMode: 'CODING',
      confidence: 'HIGH',
      reasonCode: 'CODE_REPOSITORY_TASK',
    })
  })

  it('recommends DESIGN for a planning and spatial-analysis task', () => {
    expect(
      recommendXiaoguiModeV1({
        currentMode: 'WORK',
        text: '请用 GIS 和坐标图层完成候选地缓冲区与可达性分析，给出规划方案',
      }),
    ).toMatchObject({
      recommendedMode: 'DESIGN',
      confidence: 'HIGH',
      reasonCode: 'PLANNING_SPATIAL_TASK',
    })
  })

  it('recommends WORK for a document-delivery task', () => {
    expect(
      recommendXiaoguiModeV1({
        currentMode: 'CODING',
        text: '请整理这批资料清单，按模板改写并输出成品 DOCX 报告',
      }),
    ).toMatchObject({
      recommendedMode: 'WORK',
      confidence: 'HIGH',
      reasonCode: 'DOCUMENT_WORK_TASK',
    })
  })

  it('does not treat an embedded Python snippet in a report as a coding task', () => {
    expect(
      recommendXiaoguiModeV1({
        currentMode: 'WORK',
        text: '这份报告中有一段 Python 代码，请帮我概括它说明了什么',
      }),
    ).toBeNull()
  })

  it('honors an explicit request not to switch modes', () => {
    expect(
      recommendXiaoguiModeV1({
        currentMode: 'WORK',
        text: '不要切换模式，请修复仓库里的 TypeScript 构建报错并补单元测试',
      }),
    ).toBeNull()
  })

  it('does not guess when planning and document-delivery signals are both sufficient', () => {
    expect(
      recommendXiaoguiModeV1({
        currentMode: 'CODING',
        text: '请用 GIS 完成充电桩选址、缓冲区和可达性分析，并输出 DOCX 成品报告',
      }),
    ).toBeNull()
    expect(
      recommendXiaoguiModeV1({
        currentMode: 'CODING',
        text: '帮我写充电桩选址报告',
      }),
    ).toBeNull()
  })

  it('treats attachment extensions as weak signals and never as enough evidence alone', () => {
    const recommendation = recommendXiaoguiModeV1({
      currentMode: 'WORK',
      text: '请修复仓库里的报错并提交修改',
      attachmentNames: ['src/app.ts'],
    })
    expect(recommendation).toMatchObject({
      recommendedMode: 'CODING',
      confidence: 'MEDIUM',
    })
    expect(recommendation?.matchedSignals).toContain('CODE_ATTACHMENT')

    expect(
      recommendXiaoguiModeV1({
        currentMode: 'WORK',
        text: '请查看这个附件并给出建议',
        attachmentNames: ['src/app.ts'],
      }),
    ).toBeNull()
  })

  it('does not recommend from a lone keyword and never stores draft text in matchedSignals', () => {
    expect(
      recommendXiaoguiModeV1({
        currentMode: 'WORK',
        text: '请帮我看看这里提到的 Python 内容',
      }),
    ).toBeNull()

    const recommendation = recommendXiaoguiModeV1({
      currentMode: 'WORK',
      text: '请修复仓库里的报错并提交修改',
      attachmentNames: ['private-module.ts'],
    })
    expect(recommendation?.matchedSignals).toEqual([
      'CODE_CHANGE',
      'REPOSITORY_WORKFLOW',
      'CODE_ATTACHMENT',
    ])
    expect(recommendation?.matchedSignals.join(' ')).not.toContain('private-module.ts')
    expect(recommendation?.matchedSignals.join(' ')).not.toContain('请修复仓库')
  })
})
