import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSession,
  ExtensionAPI,
  InlineExtension,
  LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'

import { workerPromptContextToolNamesForModeV1 } from '@shared/xiaogui-prompt-capabilities'

import { initSession, st } from '../worker-runtime'
import { freezeCodingContextAgentPayloadV1 } from '../xiaogui-coding-extensions/context-extension'
import {
  XIAOGUI_CODING_TRANSPARENT_CAPABILITIES_V1,
  XIAOGUI_CODING_TRANSPARENT_HARNESS_MARKER_V1,
} from '../xiaogui-coding-extensions/transparent-harness-extension'
import { freezeXiaoguiPromptContextV1 } from '../xiaogui-prompt/session-binding'

type ExtensionHandler = (event: never, context: never) => unknown

async function registerFactory(extension: InlineExtension): Promise<Map<string, ExtensionHandler[]>> {
  const handlers = new Map<string, ExtensionHandler[]>()
  const factory = typeof extension === 'function' ? extension : extension.factory
  await factory({
    on: vi.fn((event: string, handler: ExtensionHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    }),
  } as unknown as ExtensionAPI)
  return handlers
}

/**
 * 回归：SDK createAgentSession 的 tools 选项同时是注册表白名单
 * （allowedToolNames）与初始激活集。若只传首轮默认工具，后续轮次被 Host
 * Tool Policy 选中的能力工具（如 work.template-intake 的 intake/materialize）
 * 会被永久踢出注册表，setActiveToolsByName 对未注册名静默忽略。
 * 这里钉住：注册表传本模式全集；创建后初始激活仍按首轮策略收窄。
 */
describe('worker-runtime session tool registry whitelist', () => {
  afterEach(() => {
    st.session = null
    st.modelRuntime = null
    st.runtime = null
    st.sdk = null
    st.sharedEventBus = null
    st.uiBridge = null
    st.widgetHost = null
    st.promptContext = null
    st.promptContextCandidate = null
    st.promptTurnContext = null
    st.promptStickyCapabilities = []
    st.promptTurnStickyCapabilities = []
    st.pendingPromptContext = null
    st.promptDiagnostics = null
    st.effectivePrompt = null
    st.promptPreflight = null
    st.promptCodingContext = null
    st.agentTurnActive = false
    st.currentSessionId = ''
    st.currentRunId = ''
    st.currentTurnId = ''
    st.currentCwd = ''
    st.bundledSkillPaths = []
  })

  it('passes the full mode tool universe as the registry whitelist, then narrows initial active tools', async () => {
    const universe = workerPromptContextToolNamesForModeV1('WORK')
    const captured: {
      tools?: readonly string[]
      additionalSkillPaths?: readonly string[]
      extensionFactories?: readonly InlineExtension[]
    } = {}
    const activeCalls: string[][] = []
    let active: string[] = []
    let overrideResult: LoadExtensionsResult | null = null

    const modelRuntime = {
      getModel: vi.fn(() => undefined),
      getAvailable: vi.fn(async () => []),
      refresh: vi.fn(async () => ({ providers: [] })),
    }
    const session = {
      sessionId: 'sess-probe',
      sessionFile: 'D:\\ws\\sess-probe.jsonl',
      model: { provider: 'p', id: 'm' },
      thinkingLevel: 'off',
      systemPrompt: 'pi-system-prompt',
      settingsManager: { isProjectTrusted: () => true },
      sessionManager: { getCwd: () => 'D:\\ws', getBranch: () => [] },
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(async () => {}),
      setActiveToolsByName: vi.fn((names: string[]) => {
        activeCalls.push([...names])
        active = [...names]
      }),
      getActiveToolNames: () => [...active],
      getAllTools: () => universe.map((name) => ({ name })),
      getToolDefinition: () => undefined,
      modelRuntime,
    } as unknown as AgentSession

    st.sdk = {
      createEventBus: () => ({ on: () => () => {} }),
      getAgentDir: () => 'D:\\agent',
      SessionManager: { create: vi.fn((cwd: string) => ({ getCwd: () => cwd })) },
      createAgentSessionServices: vi.fn(async (options) => {
        captured.additionalSkillPaths = options.resourceLoaderOptions.additionalSkillPaths
        captured.extensionFactories = [...(options.resourceLoaderOptions.extensionFactories ?? [])]
        overrideResult = options.resourceLoaderOptions.extensionsOverride({
          extensions: [],
        } as unknown as LoadExtensionsResult)
        return {
          resourceLoader: { getSystemPrompt: () => null },
          modelRuntime,
          diagnostics: [],
        }
      }),
      createAgentSessionFromServices: vi.fn(async (options) => {
        captured.tools = [...options.tools]
        return { session }
      }),
      createAgentSessionRuntime: vi.fn(async (createRuntime, options) => {
        const made = await createRuntime({
          cwd: options.cwd,
          agentDir: 'D:\\agent',
          sessionManager: options.sessionManager,
          sessionStartEvent: undefined,
        })
        return {
          session: made.session,
          services: made.services,
          modelFallbackMessage: null,
          setBeforeSessionInvalidate: vi.fn(),
          setRebindSession: vi.fn(),
          dispose: vi.fn(async () => {}),
        }
      }),
    } as never
    st.sharedEventBus = { on: () => () => {} } as never

    await initSession('D:\\ws', freezeXiaoguiPromptContextV1({
      schemaVersion: 1,
      mode: 'WORK',
      phase: 'EXECUTE',
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: ['work.file-organize'],
      availableToolNames: ['read'],
      sessionKey: 'xgs1_probe',
      projectId: 'xgp1_probe',
    }), ['D:\\app\\resources\\pi-skills'])

    expect(captured.additionalSkillPaths).toEqual(['D:\\app\\resources\\pi-skills'])

    // 注册表白名单 = 本模式全部候选工具（含非默认能力的 intake/materialize）。
    expect(captured.tools).toEqual([...universe])
    expect(captured.tools).toContain('xiaogui_work_docx_template_intake')
    expect(captured.tools).toContain('xiaogui_work_docx_template_materialize')

    // 创建后初始激活集按首轮策略（空输入 → 默认能力）收窄。
    expect(activeCalls.length).toBeGreaterThan(0)
    expect(activeCalls.at(-1)).toEqual([
      'read',
      'xiaogui_read_pdf',
      'xiaogui_work_read_materials',
    ])

    // override 链确实注册了 intake/materialize 工具。
    const registered = (overrideResult as unknown as LoadExtensionsResult).extensions
      .flatMap((extension) => [...extension.tools.keys()])
    expect(registered).toContain('xiaogui_work_docx_template_intake')
    expect(registered).toContain('xiaogui_work_docx_template_materialize')

    // WORK 只加载公共 Prompt Extension；它没有 CODING 的上下文或工具硬门。
    const workFactories = [...(captured.extensionFactories ?? [])]
    expect(workFactories.length).toBeGreaterThan(0)
    const workRegistrations = await Promise.all(workFactories.map(registerFactory))
    expect(workRegistrations.some((entry) => entry.has('context'))).toBe(false)
    expect(workRegistrations.some((entry) => entry.has('tool_call'))).toBe(false)

    await initSession('D:\\ws', freezeXiaoguiPromptContextV1({
      schemaVersion: 1,
      mode: 'CODING',
      phase: 'EXECUTE',
      workspaceAvailable: true,
      projectTrusted: true,
      enabledCapabilities: ['coding.workspace'],
      availableToolNames: ['read'],
      sessionKey: 'xgs1_coding_probe',
      projectId: 'xgp1_coding_probe',
    }))
    const codingFactories = [...(captured.extensionFactories ?? [])]
    expect(codingFactories).toContainEqual(expect.objectContaining({
      name: 'xiaogui-coding-transparent-harness-v1',
      hidden: true,
    }))
    const codingRegistrations = await Promise.all(codingFactories.map(registerFactory))

    // 不再只比较 Extension 数量：实际触发 CODING 初始化交给 Pi 的隐藏
    // Extension，证明透明能力包、角色硬门和受控上下文三条行为接缝。
    const beforeAgentStartResults = await Promise.allSettled(
      codingRegistrations.flatMap((entry) => entry.get('before_agent_start') ?? []).map((handler) =>
        Promise.resolve(handler({
          systemPrompt: 'Pi base prompt',
          systemPromptOptions: {
            selectedTools: [],
            toolSnippets: {},
            promptGuidelines: [],
            customPrompt: false,
          },
        } as never, {
          isProjectTrusted: () => true,
          abort: vi.fn(),
        } as never)),
      ),
    )
    const injectedPrompts = beforeAgentStartResults
      .filter((result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled')
      .map((result) => (result.value as { systemPrompt?: string } | undefined)?.systemPrompt ?? '')
    const transparentPrompt = injectedPrompts.find((prompt) =>
      prompt.includes(XIAOGUI_CODING_TRANSPARENT_HARNESS_MARKER_V1)
      && prompt.includes('不得强制切换到 ASK 或 PLAN')
      && prompt.includes('真实差异和实际验证结果'))
    expect(transparentPrompt).toBeTruthy()
    expect(transparentPrompt).not.toMatch(/\bOMP\b|Oh My Pi/i)
    expect(XIAOGUI_CODING_TRANSPARENT_CAPABILITIES_V1).toEqual([
      'PROJECT_RULES_AND_SKILLS',
      'CONTROLLED_CONTEXT',
      'ROLE_SCOPED_TOOLS',
      'HOST_MEDIATED_PERMISSION',
      'USER_SELECTED_PLANNING',
      'EVIDENCE_AND_CHECKPOINT',
    ])

    const roleRegistration = codingRegistrations.find((entry) => entry.has('tool_call'))
    expect(roleRegistration?.get('tool_call')?.[0]?.({ toolName: 'write' } as never, {} as never))
      .toEqual({
        block: true,
        reason: 'XIAOGUI_CODING_ROLE_BINDING_REQUIRED',
        terminate: true,
      })

    st.promptCodingContext = freezeCodingContextAgentPayloadV1({
      schemaVersion: 1,
      snapshotIds: ['xgctx_12345678-1234-1234-1234-123456789abc'],
      sources: [{ relativePath: 'src/feature.ts', content: 'export const value = 1', truncated: false }],
      symbolService: 'UNAVAILABLE',
      diagnosticService: 'UNAVAILABLE',
    })
    const contextRegistration = codingRegistrations.find((entry) => entry.has('context'))
    const contextResult = await contextRegistration?.get('context')?.[0]?.({
      type: 'context',
      messages: [],
    } as never, {} as never) as { messages?: Array<{ content?: string }> } | undefined
    expect(contextResult?.messages?.at(-1)?.content).toContain('"relativePath":"src/feature.ts"')
    expect(JSON.stringify(contextResult)).not.toMatch(/[A-Z]:[\\/]/)

    expect(captured.tools).toEqual([...workerPromptContextToolNamesForModeV1('CODING')])
  })
})
