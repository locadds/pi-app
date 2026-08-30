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
  xiaoguiPromptBuilderV1,
  type BuiltEffectiveXiaoguiPromptV1,
  type XiaoguiRuntimePromptToolV1,
} from './builder'
import { freezeXiaoguiPromptContextV1 } from './session-binding'

export interface XiaoguiEffectivePromptSessionStateV1 {
  readonly context: XiaoguiPromptContextV1
  readonly diagnostics: XiaoguiEffectivePromptDiagnosticsV1
}

export type XiaoguiPromptStateSinkV1 = (state: XiaoguiEffectivePromptSessionStateV1) => void

export interface XiaoguiPromptInlineExtensionV1 {
  readonly name: string
  readonly hidden: true
  readonly factory: ExtensionFactory
}

type PiToolFacts = Pick<BuildSystemPromptOptions, 'selectedTools' | 'toolSnippets' | 'promptGuidelines'>

function normalizeToolsFromPromptOptions(options: PiToolFacts): XiaoguiRuntimePromptToolV1[] {
  const selected = [...new Set(options.selectedTools ?? [])]
  const sharedGuidelines = options.promptGuidelines ?? []
  return selected.map((name) => ({
    name,
    promptSnippet: options.toolSnippets?.[name],
    // Pi exposes the merged active guideline list at this seam. Attach it once
    // so Builder can deduplicate while preserving the exact current set.
    promptGuidelines: name === selected[0] ? sharedGuidelines : [],
  }))
}

function normalizeToolsFromSession(session: AgentSession): XiaoguiRuntimePromptToolV1[] {
  return session.getActiveToolNames().map((name) => {
    const definition = session.getToolDefinition(name)
    return {
      name,
      promptSnippet: definition?.promptSnippet,
      promptGuidelines: definition?.promptGuidelines,
    }
  })
}

function withActualTools(
  context: XiaoguiPromptContextV1,
  tools: readonly XiaoguiRuntimePromptToolV1[],
  projectTrusted: boolean,
): XiaoguiPromptContextV1 {
  const actualNames = [...new Set(tools.map((tool) => tool.name).filter(Boolean))].sort()
  for (const requiredName of context.availableToolNames) {
    if (!actualNames.includes(requiredName)) {
      throw new Error('XIAOGUI_PROMPT_CONTEXT_TOOL_MISMATCH')
    }
  }
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
): BuiltEffectiveXiaoguiPromptV1 {
  return xiaoguiPromptBuilderV1.build({
    context: withActualTools(context, tools, projectTrusted),
    piSystemPrompt: systemPrompt,
    piCustomSystem,
    runtimeTools: tools,
  })
}

/**
 * Last inline Pi extension. Pi invokes it after project/user extensions and
 * passes its real 0.84.1 assembled Prompt. The captured Context is immutable,
 * so a running Turn cannot observe a later Main-process mode/phase change.
 */
export function createXiaoguiPromptSessionExtensionV1(
  rawContext: XiaoguiPromptContextV1,
  onState: XiaoguiPromptStateSinkV1,
  onFailure: (error: unknown) => void = () => {},
): XiaoguiPromptInlineExtensionV1 {
  const context = freezeXiaoguiPromptContextV1(rawContext)
  return {
    name: 'xiaogui-prompt-context-v1',
    hidden: true,
    factory(pi) {
      pi.on('before_agent_start', async (event, extensionContext) => {
        try {
          const tools = normalizeToolsFromPromptOptions(event.systemPromptOptions)
          const result = build(
            context,
            event.systemPrompt,
            !!event.systemPromptOptions.customPrompt,
            tools,
            extensionContext.isProjectTrusted(),
          )
          onState({ context: result.effectiveContext, diagnostics: result.diagnostics })
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
  return { context: result.effectiveContext, diagnostics: result.diagnostics }
}
