import {
  TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1,
  XIAOGUI_CAPABILITY_REGISTRY_ID_V1,
  XIAOGUI_CAPABILITY_REGISTRY_VERSION_V1,
  XIAOGUI_CAPABILITY_REGISTRY_V1,
  XIAOGUI_SHARED_TOOL_PROMPT_RULES_V1,
  XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1,
} from '@shared/xiaogui-prompt-capabilities'

export const XIAOGUI_PRODUCT_SYSTEM_LAYERS_PREVIEW_URI =
  'xiaogui://prompt-catalog/product-system-layers-preview' as const
export const XIAOGUI_CAPABILITY_REGISTRY_RESOURCE_URI =
  'xiaogui://prompt-catalog/capability-registry' as const
export const XIAOGUI_TOOL_GUIDELINES_RESOURCE_URI =
  'xiaogui://prompt-catalog/tool-guidelines' as const
export const XIAOGUI_TEMPLATE_INTAKE_SUBTASK_RESOURCE_URI =
  'xiaogui://prompt-catalog/subtask/template-intake-analysis' as const

export interface CodeOwnedPromptCatalogResourceV1 {
  readonly id: string
  readonly uri: string
  readonly name: string
  readonly description: string
  readonly content: string
}

function capabilityRegistryMarkdown(): string {
  const sections = Object.values(XIAOGUI_CAPABILITY_REGISTRY_V1).map((capability) => {
    const modes = Object.entries(capability.modes)
      .map(([mode, policy]) => `${mode}=${policy}`)
      .join('；')
    const tools = capability.tools.length > 0
      ? capability.tools.map((tool) => `${tool.name}（${tool.source}）`).join('、')
      : '无'
    const requiredTools = capability.requiredToolNames.length > 0
      ? capability.requiredToolNames.join('、')
      : '无'

    return [
      `## ${capability.id}@${capability.version}`,
      '',
      `- 模式策略：${modes}`,
      `- 最低副作用等级：${capability.minimumEffect}`,
      `- 声明工具：${tools}`,
      `- 必需工具：${requiredTools}`,
      `- Prompt Layer：${capability.promptLayer.id}@${capability.promptLayer.version}`,
      '',
      capability.promptLayer.content,
    ].join('\n')
  })

  return [
    `# ${XIAOGUI_CAPABILITY_REGISTRY_ID_V1}@${XIAOGUI_CAPABILITY_REGISTRY_VERSION_V1}`,
    '',
    '这是小规代码内置的只读 Capability 注册表视图。它用于诊断，不会作为独立资源再次注入 System Context。',
    '',
    ...sections,
  ].join('\n\n')
}

function toolGuidelinesMarkdown(): string {
  const sharedRules = Object.values(XIAOGUI_SHARED_TOOL_PROMPT_RULES_V1)
    .map((rule) => `- \`${rule.id}\`：${rule.content}`)
  const sections = Object.values(XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1).map((tool) => {
    const usage = [
      ...(tool.usage?.when ?? []),
      ...(tool.usage?.whenNot ?? []),
    ]
    const protocol = [
      ...(tool.protocol?.sequence ?? []),
      ...(tool.protocol?.output ?? []),
    ]
    return [
      `## ${tool.name}`,
      '',
      `- 名称：${tool.label}`,
      `- 说明：${tool.description}`,
      `- Prompt 摘要：${tool.promptSnippet}`,
      `- 共享规则引用：${tool.sharedRuleIds?.map((id) => `\`${id}\``).join('、') || '无'}`,
      '',
      '### 何时调用/不调用',
      ...usage.map((guideline) => `- ${guideline}`),
      '',
      '### 调用协议',
      ...protocol.map((guideline) => `- ${guideline}`),
    ].join('\n')
  })

  return [
    '# 小规 Tool Guidelines',
    '',
    '这是小规代码内置的只读工具使用准则视图。实际会话仍以运行时注册结果和 Effective Prompt Manifest 为准。',
    '',
    '## 共享规则',
    '',
    ...sharedRules,
    '',
    ...sections,
  ].join('\n\n')
}

export const XIAOGUI_CODE_OWNED_PROMPT_CATALOG_RESOURCES_V1:
readonly CodeOwnedPromptCatalogResourceV1[] = [
  {
    id: 'builtin:capability-registry',
    uri: XIAOGUI_CAPABILITY_REGISTRY_RESOURCE_URI,
    name: 'Capability 注册表（只读）',
    description: '代码内置的 Capability、模式策略、副作用等级与 Prompt Layer',
    content: capabilityRegistryMarkdown(),
  },
  {
    id: 'builtin:tool-guidelines',
    uri: XIAOGUI_TOOL_GUIDELINES_RESOURCE_URI,
    name: 'Tool 使用准则（只读）',
    description: '代码内置的工具说明、Prompt 摘要与调用边界',
    content: toolGuidelinesMarkdown(),
  },
  {
    id: 'builtin:subtask:template-intake-analysis',
    uri: XIAOGUI_TEMPLATE_INTAKE_SUBTASK_RESOURCE_URI,
    name: `${TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.id}@${TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.version}`,
    description: '普通成品文档模板整理使用的专用模型子任务 Prompt（只读）',
    content: TEMPLATE_INTAKE_ANALYSIS_MODEL_PROMPT_V1.systemPrompt,
  },
] as const

const RESOURCE_BY_URI = new Map(
  XIAOGUI_CODE_OWNED_PROMPT_CATALOG_RESOURCES_V1.map((resource) => [resource.uri, resource]),
)

export function readCodeOwnedPromptCatalogResourceV1(
  uri: string,
): CodeOwnedPromptCatalogResourceV1 | null {
  return RESOURCE_BY_URI.get(uri) ?? null
}
