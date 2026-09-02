import type {
  AgentSession,
  AgentSessionServices,
  BuildSystemPromptOptions,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent'

import type {
  XiaoguiEffectivePromptDiagnosticsV1,
  XiaoguiPromptContextV1,
} from '@shared/xiaogui-prompt-contract'
import {
  XIAOGUI_SHARED_TOOL_PROMPT_RULES_V1,
  XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1,
} from '@shared/xiaogui-prompt-capabilities'

import {
  xiaoguiPromptBuilderV1,
  type BuiltEffectiveXiaoguiPromptV1,
  type XiaoguiRuntimePromptToolV1,
} from './builder'
import { freezeXiaoguiPromptContextV1 } from './session-binding'

export interface XiaoguiEffectivePromptSessionStateV1 {
  /** Worker-only body from the same Builder invocation as `diagnostics`. */
  readonly prompt: string
  /** Code-owned product Layers only; the only body eligible for diagnostics. */
  readonly productPrompt: string
  readonly context: XiaoguiPromptContextV1
  readonly diagnostics: XiaoguiEffectivePromptDiagnosticsV1
}

export type XiaoguiPromptStateSinkV1 = (state: XiaoguiEffectivePromptSessionStateV1) => void

export interface XiaoguiPromptInlineExtensionV1 {
  readonly name: string
  readonly hidden: true
  readonly factory: ExtensionFactory
}

export type XiaoguiPromptContextSourceV1 =
  | XiaoguiPromptContextV1
  | (() => XiaoguiPromptContextV1)

type PiToolFacts = Pick<BuildSystemPromptOptions, 'selectedTools' | 'toolSnippets' | 'promptGuidelines'>

interface NormalizedRuntimePromptToolsV1 {
  readonly tools: readonly XiaoguiRuntimePromptToolV1[]
  readonly compatibilityGuidelines: readonly string[]
}

function normalizeTool(
  name: string,
  promptSnippet?: string,
  promptGuidelines?: readonly string[],
): XiaoguiRuntimePromptToolV1 {
  const known = name in XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1
    ? XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1[
        name as keyof typeof XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1
      ]
    : undefined
  if (!known) return { name, promptSnippet, promptGuidelines }
  return {
    name,
    promptSnippet: promptSnippet ?? known.promptSnippet,
    promptGuidelines: known.promptGuidelines,
    sharedRules: (known.sharedRuleIds ?? []).map((id) => XIAOGUI_SHARED_TOOL_PROMPT_RULES_V1[id]),
    usage: known.usage,
    protocol: known.protocol,
  }
}

function normalizeToolsFromPromptOptions(options: PiToolFacts): NormalizedRuntimePromptToolsV1 {
  const selected = [...new Set(options.selectedTools ?? [])]
  const knownGuidelines = new Set(selected.flatMap((name) => {
    if (!(name in XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1)) return []
    return XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1[
      name as keyof typeof XIAOGUI_WORKER_TOOL_PROMPT_DEFINITIONS_V1
    ].promptGuidelines
  }))
  return {
    tools: selected.map((name) => normalizeTool(name, options.toolSnippets?.[name])),
    // Pi 0.84.1 merges these rows and no longer exposes Tool ownership here.
    // Known small-rule rows are reconstructed above; the remainder stays in a
    // clearly labelled compatibility group instead of being assigned wrongly.
    compatibilityGuidelines: (options.promptGuidelines ?? [])
      .filter((guideline) => !knownGuidelines.has(guideline)),
  }
}

function normalizeToolsFromSession(session: AgentSession): XiaoguiRuntimePromptToolV1[] {
  return session.getActiveToolNames().map((name) => {
    const definition = session.getToolDefinition(name)
    return normalizeTool(name, definition?.promptSnippet, definition?.promptGuidelines)
  })
}

function withActualTools(
  context: XiaoguiPromptContextV1,
  tools: readonly XiaoguiRuntimePromptToolV1[],
  projectTrusted: boolean,
): XiaoguiPromptContextV1 {
  const actualNames = [...new Set(tools.map((tool) => tool.name).filter(Boolean))].sort()
  return freezeXiaoguiPromptContextV1({
    ...context,
    projectTrusted,
    availableToolNames: actualNames,
  })
}

function build(
  context: XiaoguiPromptContextV1,
  systemPrompt: string,
  piCustomSystem: boolean,
  tools: readonly XiaoguiRuntimePromptToolV1[],
  projectTrusted: boolean,
  compatibilityGuidelines: readonly string[] = [],
): BuiltEffectiveXiaoguiPromptV1 {
  return xiaoguiPromptBuilderV1.build({
    context: withActualTools(context, tools, projectTrusted),
    piSystemPrompt: systemPrompt,
    piCustomSystem,
    runtimeTools: tools,
    runtimeCompatibilityGuidelines: compatibilityGuidelines,
  })
}

/**
 * Last inline Pi extension. Pi invokes it after project/user extensions and
 * passes its real 0.84.1 assembled Prompt. The Worker supplies a frozen turn
 * snapshot, so a running Turn cannot observe later capability or mode changes.
 */
export function createXiaoguiPromptSessionExtensionV1(
  contextSource: XiaoguiPromptContextSourceV1,
  onState: XiaoguiPromptStateSinkV1,
  onFailure: (error: unknown) => void = () => {},
): XiaoguiPromptInlineExtensionV1 {
  const readContext = (): XiaoguiPromptContextV1 => freezeXiaoguiPromptContextV1(
    typeof contextSource === 'function' ? contextSource() : contextSource,
  )
  return {
    name: 'xiaogui-prompt-context-v1',
    hidden: true,
    factory(pi) {
      pi.on('before_agent_start', async (event, extensionContext) => {
        try {
          // The Worker freezes this snapshot before it changes active tools.
          // A queued/streaming turn continues to observe the same object.
          const context = readContext()
          const normalizedTools = normalizeToolsFromPromptOptions(event.systemPromptOptions)
          const result = build(
            context,
            event.systemPrompt,
            !!event.systemPromptOptions.customPrompt,
            normalizedTools.tools,
            extensionContext.isProjectTrusted(),
            normalizedTools.compatibilityGuidelines,
          )
          onState({
            prompt: result.prompt,
            productPrompt: result.productPrompt,
            context: result.effectiveContext,
            diagnostics: result.diagnostics,
          })
          return { systemPrompt: result.prompt }
        } catch (error) {
          onFailure(error)
          extensionContext.abort()
          throw error
        }
      })
    },
  }
}

/** Initial safe Manifest returned with Session identity before the first Turn. */
export function buildXiaoguiPromptSessionStateV1(
  session: AgentSession,
  services: AgentSessionServices,
  rawContext: XiaoguiPromptContextV1,
): XiaoguiEffectivePromptSessionStateV1 {
  const context = freezeXiaoguiPromptContextV1(rawContext)
  const actualTrust = session.settingsManager?.isProjectTrusted?.() ?? false
  const result = build(
    context,
    session.systemPrompt,
    !!services.resourceLoader.getSystemPrompt(),
    normalizeToolsFromSession(session),
    actualTrust,
  )
  return {
    prompt: result.prompt,
    productPrompt: result.productPrompt,
    context: result.effectiveContext,
    diagnostics: result.diagnostics,
  }
}
