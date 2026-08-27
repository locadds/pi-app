import { describe, expect, it } from 'vitest'

import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import { addXiaoguiCollaborationTool } from './xiaogui-collaboration-tool'
import { addXiaoguiWorkDocumentSnapshotTool } from './xiaogui-work-document-snapshot-tool'
import { addXiaoguiWorkDocxAdvancedGenerationTool } from './xiaogui-work-docx-advanced-generation-tool'
import { addXiaoguiWorkDocxTemplateDataTool } from './xiaogui-work-docx-template-data-tool'
import { addXiaoguiWorkDocxTemplateIntakeTool } from './xiaogui-work-docx-template-intake-tool'
import { addXiaoguiWorkDocxTemplateMaterializeTool } from './xiaogui-work-docx-template-materialize-tool'
import {
  assertXiaoguiModelToolSchemasCompatible,
  XIAOGUI_MODEL_TOOL_SCHEMA_INCOMPATIBLE,
} from './xiaogui-model-tool-schema-compatibility'

function loadXiaoguiModelTools(): LoadExtensionsResult {
  const base = { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult
  const sessionOptions = {
    getSourceSessionId: () => 'session-1',
    getSourceRunId: () => 'run-1',
  }

  return addXiaoguiWorkDocxAdvancedGenerationTool(
    addXiaoguiWorkDocumentSnapshotTool(
      addXiaoguiWorkDocxTemplateMaterializeTool(
        addXiaoguiWorkDocxTemplateIntakeTool(
          addXiaoguiWorkDocxTemplateDataTool(
            addXiaoguiCollaborationTool(base, {
              getSourceSessionId: sessionOptions.getSourceSessionId,
              getSourceTurnId: () => 'turn-1',
            }),
            sessionOptions,
          ),
          sessionOptions,
        ),
        sessionOptions,
      ),
      sessionOptions,
    ),
    sessionOptions,
  )
}

describe('小规模型工具结构兼容性', () => {
  it('所有内置工具都提供 OpenAI 兼容接口要求的顶层 object 参数结构', () => {
    const loaded = loadXiaoguiModelTools()
    const invalidTools = loaded.extensions.flatMap((extension) =>
      [...extension.tools.values()]
        .filter(({ sourceInfo }) => sourceInfo.source === 'xiaogui-desktop')
        .filter(({ definition }) => (definition.parameters as { type?: unknown }).type !== 'object')
        .map(({ definition }) => definition.name),
    )

    expect(invalidTools).toEqual([])
    expect(assertXiaoguiModelToolSchemasCompatible(loaded)).toBe(loaded)
  })

  it('未来新增的顶层非 object 小规工具会在本地装配阶段被阻止', () => {
    const loaded = loadXiaoguiModelTools()
    const firstXiaoguiTool = loaded.extensions
      .flatMap((extension) => [...extension.tools.values()])
      .find(({ sourceInfo }) => sourceInfo.source === 'xiaogui-desktop')
    expect(firstXiaoguiTool).toBeDefined()
    Object.assign(firstXiaoguiTool!.definition, { parameters: { anyOf: [] } })

    expect(() => assertXiaoguiModelToolSchemasCompatible(loaded)).toThrow(
      XIAOGUI_MODEL_TOOL_SCHEMA_INCOMPATIBLE,
    )
  })
})
