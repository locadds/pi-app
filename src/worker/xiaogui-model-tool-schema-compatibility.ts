import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

export const XIAOGUI_MODEL_TOOL_SCHEMA_INCOMPATIBLE =
  'XIAOGUI_MODEL_TOOL_SCHEMA_INCOMPATIBLE' as const

/**
 * OpenAI 及大量兼容接口要求函数 parameters 的顶层必须是 JSON Schema object。
 * 在小规内置工具装配结束时统一拦截，避免未来新增工具把顶层 anyOf/oneOf 带到模型请求。
 */
export function assertXiaoguiModelToolSchemasCompatible(
  loaded: LoadExtensionsResult,
): LoadExtensionsResult {
  const invalidTools = loaded.extensions.flatMap((extension) =>
    [...extension.tools.values()]
      .filter(({ sourceInfo }) => sourceInfo.source === 'xiaogui-desktop')
      .filter(({ definition }) => {
        const parameters = definition.parameters as { type?: unknown } | null | undefined
        return parameters?.type !== 'object'
      })
      .map(({ definition }) => definition.name),
  )

  if (invalidTools.length > 0) {
    throw new Error(
      `[${XIAOGUI_MODEL_TOOL_SCHEMA_INCOMPATIBLE}] 小规模型工具的顶层 parameters 必须为 JSON Schema object: ${invalidTools.join(', ')}`,
    )
  }
  return loaded
}
