import { createHash } from 'node:crypto'

import {
  assertStaticXiaoguiPromptLayerV1,
  parseXiaoguiPromptContextV1,
  type EffectivePromptLayerManifestV1,
  type XiaoguiEffectivePromptDiagnosticsV1,
  type XiaoguiPromptContextV1,
  type XiaoguiPromptLayerV1,
} from '@shared/xiaogui-prompt-contract'
import {
  isKnownXiaoguiCapabilityToolNameV1,
  isXiaoguiCapabilityToolAllowedInModeV1,
  isXiaoguiWorkerBuiltinToolAllowedForPromptContextV1,
  resolveEffectiveXiaoguiCapabilitiesV1,
  XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1,
} from '@shared/xiaogui-prompt-capabilities'

import { XIAOGUI_PRODUCT_PROMPT_LAYERS_V1 } from './layers'

const PRODUCT_BEGIN = '<!-- XIAOGUI:PRODUCT:BEGIN -->'
const PRODUCT_END = '<!-- XIAOGUI:PRODUCT:END -->'
const LEGACY_DESIGN_BEGIN = '<!-- XIAOGUI:DESIGN:BEGIN -->'
const LEGACY_DESIGN_END = '<!-- XIAOGUI:DESIGN:END -->'

export const XIAOGUI_RUNTIME_FACTS_MAX_CHARACTERS_V1 = 600 as const
export const XIAOGUI_PRODUCT_PROMPT_MAX_CHARACTERS_V1 = 7_000 as const

export interface XiaoguiRuntimePromptToolV1 {
  readonly name: string
  readonly promptSnippet?: string
  readonly promptGuidelines?: readonly string[]
}

export interface BuildEffectiveXiaoguiPromptInputV1 {
  readonly context: XiaoguiPromptContextV1
  /** Pi 0.84.1's real assembled prompt, including user SYSTEM and project context. */
  readonly piSystemPrompt: string
  readonly piCustomSystem?: boolean
  readonly runtimeTools?: readonly XiaoguiRuntimePromptToolV1[]
  readonly generatedAt?: string
}

export interface BuiltEffectiveXiaoguiPromptV1 {
  /** Worker-only body. Never serialize this value to Main or ordinary logs. */
  readonly prompt: string
  /** Code-owned product Layers only; safe for explicit advanced diagnostics. */
  readonly productPrompt: string
  readonly effectiveContext: XiaoguiPromptContextV1
  readonly diagnostics: XiaoguiEffectivePromptDiagnosticsV1
}

export interface XiaoguiPromptBuilderV1 {
  build(input: BuildEffectiveXiaoguiPromptInputV1): BuiltEffectiveXiaoguiPromptV1
}

function fail(code: string): never {
  throw new Error(code)
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function stripMarkedBlock(
  source: string,
  begin: string,
  end: string,
  malformedCode: string,
): { content: string; found: boolean } {
  let content = source
  let found = false
  for (;;) {
    const start = content.indexOf(begin)
    const finish = content.indexOf(end)
    if (start < 0 && finish < 0) break
    if (start < 0 || finish < start) fail(malformedCode)
    const after = finish + end.length
    content = `${content.slice(0, start)}${content.slice(after)}`
    found = true
  }
  return { content: normalize(content), found }
}

function manifestLayer(layer: XiaoguiPromptLayerV1): EffectivePromptLayerManifestV1 {
  const content = normalize(layer.content)
  return {
    id: layer.id,
    version: layer.version,
    kind: layer.kind,
    required: layer.required,
    characterCount: content.length,
    sha256: sha256(content),
  }
}

function runtimeToolLayer(tools: readonly XiaoguiRuntimePromptToolV1[]): XiaoguiPromptLayerV1 | null {
  const ordered = [...tools]
    .filter((tool) => tool.name.trim())
    .sort((a, b) => a.name.localeCompare(b.name))
  const snippets = ordered
    .map((tool) => ({ name: tool.name.trim(), snippet: normalize(tool.promptSnippet ?? '') }))
    .filter((row) => row.snippet)
    .map((row) => `- ${row.name}: ${row.snippet}`)
  const guidelines = [...new Set(
    ordered.flatMap((tool) => tool.promptGuidelines ?? []).map(normalize).filter(Boolean),
  )]
  if (snippets.length === 0 && guidelines.length === 0) return null
  const parts = ['# 当前可用工具说明（Pi custom SYSTEM 兼容层）']
  if (snippets.length > 0) parts.push(`## Available Tools\n${snippets.join('\n')}`)
  if (guidelines.length > 0) parts.push(`## Tool Guidelines\n${guidelines.map((row) => `- ${row}`).join('\n')}`)
  return {
    id: 'pi.custom-system-tool-guidelines',
    version: '0.84.1-compat.1',
    kind: 'RUNTIME',
    required: true,
    content: parts.join('\n\n'),
  }
}

function runtimeFactsLayer(
  context: XiaoguiPromptContextV1,
  effectiveCapabilityIds: readonly string[],
  actualToolCount: number,
): XiaoguiPromptLayerV1 {
  const content = normalize(`# 运行事实

- 当前模式：${context.mode}
- 当前阶段：${context.phase}
- 工作区：${context.workspaceAvailable ? '可用' : '不可用'}
- 项目信任：${context.projectTrusted ? '已信任' : '未信任'}
- 本轮可用产品能力：${effectiveCapabilityIds.length > 0 ? effectiveCapabilityIds.join('、') : '无'}
- Runtime 实际加载工具：${actualToolCount} 个
- 约束：只能使用实际加载且符合当前阶段的工具；未列入可用产品能力的工作不得宣称已完成。`)
  if (content.length > XIAOGUI_RUNTIME_FACTS_MAX_CHARACTERS_V1) {
    fail('XIAOGUI_PROMPT_RUNTIME_FACTS_BUDGET_EXCEEDED')
  }
  return {
    id: 'xiaogui.runtime.facts',
    version: '1.0.0',
    kind: 'RUNTIME',
    required: true,
    content,
  }
}

function requiredLayerIds(context: XiaoguiPromptContextV1): readonly string[] {
  return [
    'xiaogui.base',
    `xiaogui.mode.${context.mode.toLowerCase()}`,
    `xiaogui.phase.${context.phase.toLowerCase()}`,
  ]
}

export function createXiaoguiPromptBuilderV1(
  registry: readonly XiaoguiPromptLayerV1[],
): XiaoguiPromptBuilderV1 {
  const byId = new Map<string, XiaoguiPromptLayerV1>()
  for (const candidate of registry) {
    const layer = assertStaticXiaoguiPromptLayerV1(candidate)
    if (byId.has(layer.id)) fail('XIAOGUI_PROMPT_LAYER_DUPLICATE')
    byId.set(layer.id, layer)
  }

  return {
    build(input) {
      const candidateContext = parseXiaoguiPromptContextV1(input.context)
      const toolNames = input.runtimeTools
        ? [...new Set(input.runtimeTools.map((tool) => tool.name.trim()).filter(Boolean))].sort()
        : candidateContext.availableToolNames
            .filter((name) =>
              !(name in XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1) ||
              isXiaoguiWorkerBuiltinToolAllowedForPromptContextV1(name, candidateContext),
            )
            .sort()
      if (toolNames.some((name) =>
        isKnownXiaoguiCapabilityToolNameV1(name) &&
        !isXiaoguiCapabilityToolAllowedInModeV1(name, candidateContext.mode),
      )) {
        fail('XIAOGUI_PROMPT_TOOL_MODE_MISMATCH')
      }
      if (toolNames.some((name) =>
        name in XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1 &&
        !isXiaoguiWorkerBuiltinToolAllowedForPromptContextV1(name, candidateContext),
      )) {
        fail('XIAOGUI_PROMPT_TOOL_PHASE_MISMATCH')
      }
      const capabilities = resolveEffectiveXiaoguiCapabilitiesV1(candidateContext, toolNames)
      const context = parseXiaoguiPromptContextV1({
        ...candidateContext,
        enabledCapabilities: capabilities.map((capability) => capability.id),
        availableToolNames: toolNames,
      })
      const capabilityToolNames = new Set(capabilities.flatMap((capability) =>
        capability.tools.map((tool) => tool.name),
      ))
      if (toolNames.some((name) =>
        name in XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1 && !capabilityToolNames.has(name),
      )) {
        fail('XIAOGUI_PROMPT_TOOL_CAPABILITY_MISMATCH')
      }
      const selected = [
        ...requiredLayerIds(context),
        ...capabilities.map((capability) => capability.promptLayer.id),
      ].map((id) => {
        const layer = byId.get(id)
        if (!layer || !layer.required) fail('XIAOGUI_PROMPT_REQUIRED_LAYER_MISSING')
        return layer
      })

      const withoutProduct = stripMarkedBlock(
        normalize(input.piSystemPrompt),
        PRODUCT_BEGIN,
        PRODUCT_END,
        'XIAOGUI_PROMPT_PRODUCT_MARKER_MALFORMED',
      )
      const withoutLegacy = stripMarkedBlock(
        withoutProduct.content,
        LEGACY_DESIGN_BEGIN,
        LEGACY_DESIGN_END,
        'XIAOGUI_PROMPT_LEGACY_DESIGN_MARKER_MALFORMED',
      )
      if (!withoutLegacy.content) fail('XIAOGUI_PROMPT_PI_SYSTEM_EMPTY')

      const piLayer: XiaoguiPromptLayerV1 = {
        id: 'pi.system-context',
        version: '0.84.1',
        kind: 'RUNTIME',
        required: true,
        content: withoutLegacy.content,
      }
      const compatibilityLayer = input.piCustomSystem
        ? runtimeToolLayer(input.runtimeTools ?? [])
        : null
      const factsLayer = runtimeFactsLayer(
        context,
        capabilities.map((capability) => capability.id),
        toolNames.length,
      )
      const productLayers = [...selected, factsLayer]
      const effectiveLayers = [piLayer, ...productLayers, ...(compatibilityLayer ? [compatibilityLayer] : [])]
      const productPrompt = productLayers
        .map((layer) => normalize(layer.content))
        .join('\n\n')
      if (productPrompt.length > XIAOGUI_PRODUCT_PROMPT_MAX_CHARACTERS_V1) {
        fail('XIAOGUI_PRODUCT_PROMPT_BUDGET_EXCEEDED')
      }
      const effectiveProductContent = [
        productPrompt,
        ...(compatibilityLayer ? [normalize(compatibilityLayer.content)] : []),
      ].join('\n\n')
      const prompt = [
        withoutLegacy.content,
        `${PRODUCT_BEGIN}\n${effectiveProductContent}\n${PRODUCT_END}`,
      ].join('\n\n')
      const completePrompt = normalize(prompt)
      return {
        prompt: completePrompt,
        productPrompt,
        effectiveContext: context,
        diagnostics: {
          manifest: {
            schemaVersion: 1,
            mode: context.mode,
            phase: context.phase,
            workspaceAvailable: context.workspaceAvailable,
            projectTrusted: context.projectTrusted,
            capabilityIds: [...context.enabledCapabilities],
            toolNames,
            layers: effectiveLayers.map(manifestLayer),
            completePromptCharacterCount: completePrompt.length,
            completePromptSha256: sha256(completePrompt),
            generatedAt: input.generatedAt ?? new Date().toISOString(),
          },
          migrationNotices: withoutLegacy.found
            ? [{ code: 'LEGACY_DESIGN_PROMPT_RUNTIME_DEDUPED', fileMutation: false }]
            : [],
        },
      }
    },
  }
}

export const xiaoguiPromptBuilderV1 = createXiaoguiPromptBuilderV1(
  XIAOGUI_PRODUCT_PROMPT_LAYERS_V1,
)
