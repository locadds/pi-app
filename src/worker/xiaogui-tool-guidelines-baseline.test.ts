import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import { workerBuiltinToolNamesFromPromptMatrixV1 } from '@shared/xiaogui-prompt-matrix'
import { addXiaoguiCollaborationTool } from './xiaogui-collaboration-tool'
import { addXiaoguiWorkDocxAdvancedGenerationTool } from './xiaogui-work-docx-advanced-generation-tool'
import { addXiaoguiWorkDocumentSnapshotTool } from './xiaogui-work-document-snapshot-tool'
import { addXiaoguiWorkReportDocxTool } from './xiaogui-work-report-docx-tool'
import { addXiaoguiWorkDocxTemplateDataTool } from './xiaogui-work-docx-template-data-tool'
import { addXiaoguiWorkDocxTemplateIntakeTool } from './xiaogui-work-docx-template-intake-tool'
import { addXiaoguiWorkDocxTemplateMaterializeTool } from './xiaogui-work-docx-template-materialize-tool'

function loadCurrentWorkerBuiltinTools() {
  const collaborationOptions = {
    getSourceSessionId: () => 'session-1',
    getSourceTurnId: () => 'turn-1',
  }
  const sessionOptions = {
    getSourceSessionId: collaborationOptions.getSourceSessionId,
    getSourceRunId: () => 'run-1',
  }
  let loaded = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  loaded = addXiaoguiCollaborationTool(loaded, collaborationOptions)
  loaded = addXiaoguiWorkDocxTemplateDataTool(loaded, sessionOptions)
  loaded = addXiaoguiWorkDocxTemplateIntakeTool(loaded, sessionOptions)
  loaded = addXiaoguiWorkDocxTemplateMaterializeTool(loaded, sessionOptions)
  loaded = addXiaoguiWorkDocumentSnapshotTool(loaded, sessionOptions)
  loaded = addXiaoguiWorkDocxAdvancedGenerationTool(loaded, sessionOptions)
  loaded = addXiaoguiWorkReportDocxTool(loaded, sessionOptions)
  return new Map(loaded.extensions.flatMap((extension) => [...extension.tools.entries()]))
}

describe('current Xiaogui Worker Tool Guidelines baseline', () => {
  it('matches the PR1 Capability / Tool matrix without changing runtime registration', () => {
    const tools = loadCurrentWorkerBuiltinTools()
    expect([...tools.keys()].sort()).toEqual(workerBuiltinToolNamesFromPromptMatrixV1())
  })

  it('freezes the current snippets and critical stop conditions', () => {
    const tools = loadCurrentWorkerBuiltinTools()
    const baseline = Object.fromEntries([...tools].map(([name, registered]) => [name, {
      promptSnippet: registered.definition.promptSnippet,
      promptGuidelines: registered.definition.promptGuidelines,
    }]))

    expect(baseline).toEqual({
      xiaogui_create_collaboration_plan: {
        promptSnippet: '把明确的多步骤协作需求写入小规协作计划，等待用户批准',
        promptGuidelines: expect.arrayContaining([
          expect.stringContaining('不要让用户填写 taskKey'),
          expect.stringContaining('不代表用户已经批准或开始执行'),
        ]),
      },
      xiaogui_read_pdf: {
        promptSnippet: '用自然语言读取 WORK 会话中的 PDF；系统选择器由用户选文件，不让用户输入路径',
        promptGuidelines: expect.arrayContaining([
          expect.stringContaining('不要让用户输入路径'),
          expect.stringContaining('快照被截断或没有正文时如实告知用户'),
        ]),
      },
      xiaogui_work_report_docx: {
        promptSnippet: '自然语言提交报告草稿、预览、跨轮确认另存、取消或打开',
        promptGuidelines: expect.arrayContaining([
          expect.stringContaining('下一条消息明确确认'),
          expect.stringContaining('不得声称覆盖或修改了已有文件'),
        ]),
      },
      xiaogui_work_docx: {
        promptSnippet: '用自然语言选择模板、整理字段、准备、确认、取消或打开 Word；生成前必须等待用户下一条确认消息',
        promptGuidelines: expect.arrayContaining([
          expect.stringContaining('不能猜测'),
          expect.stringContaining('不得同一轮调用 CONFIRM'),
        ]),
      },
      xiaogui_work_docx_template_intake: {
        promptSnippet: '用自然语言开始、调整、复核、继续、删除或取消普通文档的只读模板整理',
        promptGuidelines: expect.arrayContaining([
          expect.stringContaining('必须先询问是否整理'),
          expect.stringContaining('不得声称已经写入原文档'),
        ]),
      },
      xiaogui_work_docx_template_materialize: {
        promptSnippet: '从已确认的模板整理报告生成预览、保存模板库、另存一份、恢复、取消或打开正式模板',
        promptGuidelines: expect.arrayContaining([
          expect.stringContaining('模型不得自行构造该令牌'),
          expect.stringContaining('正式模板只能保存为新的 DOCX'),
        ]),
      },
      xiaogui_work_docx_advanced_generation: {
        promptSnippet: '自然语言选择正式模板、补齐普通字段和结构槽位、预览、确认另存、恢复或取消',
        promptGuidelines: expect.arrayContaining([
          expect.stringContaining('标为 UNRESOLVED'),
          expect.stringContaining('成品只能另存为不存在的新 DOCX'),
        ]),
      },
    })
  })
})
