import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession, LoadExtensionsResult } from '@earendil-works/pi-coding-agent'

import { workerPromptContextToolNamesForModeV1 } from '@shared/xiaogui-prompt-capabilities'

import { initSession, st } from '../worker-runtime'
import { freezeXiaoguiPromptContextV1 } from '../xiaogui-prompt/session-binding'

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
    st.agentTurnActive = false
    st.currentSessionId = ''
    st.currentRunId = ''
    st.currentTurnId = ''
    st.currentCwd = ''
    st.bundledSkillPaths = []
  })

  it('passes the full mode tool universe as the registry whitelist, then narrows initial active tools', async () => {
    const universe = workerPromptContextToolNamesForModeV1('WORK')
    const captured: { tools?: readonly string[]; additionalSkillPaths?: readonly string[] } = {}
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
  })
})
