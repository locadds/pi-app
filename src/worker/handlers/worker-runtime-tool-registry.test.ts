import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSession,
  ExtensionAPI,
  InlineExtension,
  LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent'

import { workerPromptContextToolNamesForModeV1 } from '@shared/xiaogui-prompt-capabilities'

import { bindWorkerExecutionIdentityV1, initSession, st } from '../worker-runtime'
import { freezeCodingContextAgentPayloadV1 } from '../xiaogui-coding-extensions/context-extension'
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
    st.workerExecutionIdentity = null
    st.consumedSessionOperationNonces.clear()
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
      customTools?: ReadonlyArray<{ name: string; executionMode?: string }>
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
          settingsManager: {
            getShellCommandPrefix: () => undefined,
            getShellPath: () => undefined,
          },
          diagnostics: [],
        }
      }),
      createAgentSessionFromServices: vi.fn(async (options) => {
        captured.tools = [...options.tools]
        captured.customTools = [...(options.customTools ?? [])]
        return { session }
      }),
      createReadToolDefinition: vi.fn(() => toolDefinition('read')),
      createBashToolDefinition: vi.fn(() => toolDefinition('bash')),
      createEditToolDefinition: vi.fn(() => toolDefinition('edit')),
      createWriteToolDefinition: vi.fn(() => toolDefinition('write')),
      defineTool: vi.fn((tool) => tool),
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
    bindWorkerExecutionIdentityV1({
      authorizedCwd: 'D:\\ws',
      projectIdentityDigest: `sha256:${'1'.repeat(64)}`,
      slotBindingDigest: `sha256:${'2'.repeat(64)}`,
    })

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
    const codingRegistrations = await Promise.all(codingFactories.map(registerFactory))

    // 普通 CODING 直接装配 Main 授权生命周期；不再通过提示词或第二份
    // “六能力”字符串清单冒充生产能力。四个 Pi 内置工具由 customTools
    // 覆盖，修改与命令固定串行，read 保持可并行。
    const lifecycleRegistration = codingRegistrations.find((entry) => entry.has('tool_result'))
    expect(lifecycleRegistration?.has('tool_call')).toBe(true)
    expect(captured.customTools?.map((tool) => tool.name)).toEqual(['read', 'bash', 'edit', 'write'])
    expect(captured.customTools?.find((tool) => tool.name === 'read')?.executionMode).toBeUndefined()
    expect(captured.customTools?.filter((tool) => tool.name !== 'read'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'bash', executionMode: 'sequential' }),
        expect.objectContaining({ name: 'edit', executionMode: 'sequential' }),
        expect.objectContaining({ name: 'write', executionMode: 'sequential' }),
      ]))

    // 没有 TaskHub Attempt 角色绑定时，普通 CODING 不再被角色 Extension
    // 强制只读；ASK/PLAN/EXECUTE 的硬门由生产 Prompt Capabilities 与
    // Direct Coding 生命周期共同执行。
    const roleRegistration = codingRegistrations.find((entry) =>
      entry.has('before_agent_start') && entry.has('tool_call') && !entry.has('tool_result'))
    expect(roleRegistration?.get('tool_call')?.[0]?.({ toolName: 'write' } as never, {} as never))
      .toBeUndefined()

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

function toolDefinition(name: string) {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute: vi.fn(async () => ({ content: [], details: undefined })),
  }
}
