import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as sdk from '@earendil-works/pi-coding-agent'
import { Value } from 'typebox/value'
import { afterEach, expect, it, vi } from 'vitest'
import { XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1 } from '@shared/xiaogui-prompt-matrix'
import { workerPromptContextToolNamesForModeV1 } from '@shared/xiaogui-prompt-capabilities'
import { receiveWorkerHostToolResponse } from '../worker-host-tool-channel'
import { bindWorkerExecutionIdentityV1, clearXiaoguiPromptTurnV1, initSession, prepareXiaoguiPromptTurnV1, st } from '../worker-runtime'

const sendToMainMock = vi.hoisted(() => vi.fn())

vi.mock('../worker-transport.js', () => ({ sendToMain: sendToMainMock }))

const roots: string[] = []
afterEach(async () => {
  await st.runtime?.dispose()
  st.runtime = null
  st.session = null
  st.sdk = null
  st.workerExecutionIdentity = null
  st.taskHubAttemptId = undefined
  st.taskHubDesignExtensionPath = undefined
  st.taskHubWorktreeAuthorized = undefined
  st.uiBridge = null
  st.widgetHost?.dispose()
  st.widgetHost = null
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Real locked SDK and the production Worker factory. No prompt/model request,
// Electron window, user profile, native runtime replacement or TaskHub fake.
it.each(['WORK', 'DESIGN', 'CODING'] as const)('boots the existing %s Pi harness with only the Attempt tools', async mode => {
  const root = mkdtempSync('E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/sdk-bootstrap-')
  roots.push(root)
  const project = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(project)
  mkdirSync(agentDir)
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  st.sdk = sdk
  st.sharedEventBus = sdk.createEventBus()
  st.taskHubAttemptId = 'attempt-sdk-bootstrap'
  st.taskHubWorktreeAuthorized = true
  if (mode === 'DESIGN') {
    st.taskHubDesignExtensionPath = 'E:/XiaoguiInternalCandidate/hub-runtime-01-pi-20260910/design-private-2d7/source/src/design/design-extension/index.ts'
  }
  bindWorkerExecutionIdentityV1({ authorizedCwd: project,
    projectIdentityDigest: `sha256:${'1'.repeat(64)}`, slotBindingDigest: `sha256:${'2'.repeat(64)}` })
  await initSession(project, {
    schemaVersion: 1, mode, phase: 'EXECUTE', workspaceAvailable: true, projectTrusted: true,
    projectId: `xgp1_${'3'.repeat(64)}`, sessionKey: `xgs1_${'4'.repeat(64)}`,
    enabledCapabilities: mode === 'DESIGN' ? ['design.analysis'] : [...XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1[mode]],
    availableToolNames: [...workerPromptContextToolNamesForModeV1(mode)],
  }, [])
  expect(st.runtime?.cwd).toBe(project)
  expect(st.session?.sessionManager.getCwd()).toBe(project)
  const expected = mode === 'CODING' ? ['delete', 'edit', 'read', 'rename', 'write']
    : mode === 'WORK' ? ['read', 'xiaogui_work_report_docx'] : ['design_project', 'read']
  expect(st.session?.getAllTools().map(tool => tool.name).sort()).toEqual(expected)
  const text = mode === 'CODING' ? '修改已批准的代码文件' : mode === 'WORK' ? '生成标准 Word 报告' : '查看项目概览'
  prepareXiaoguiPromptTurnV1(text)
  expect(st.session?.getActiveToolNames().sort()).toEqual(expected)
  for (const tool of expected) expect(st.session?.getToolDefinition(tool)).toBeDefined()
  expect(st.session?.getAllTools().some(tool => tool.name === 'bash')).toBe(false)
  if (mode === 'DESIGN') {
    const definition = st.session?.getToolDefinition('design_project')
    expect(definition).toBeDefined()
    if (!definition) throw new Error('DESIGN_PROJECT_DEFINITION_MISSING')

    const parameters = definition.parameters
    expect(parameters).toMatchObject({ type: 'object', additionalProperties: false })
    expect(parameters).toHaveProperty('properties.action')
    expect(parameters).toHaveProperty('properties.sourcePaths')
    expect(parameters).toHaveProperty('properties.targetPath')
    expect(parameters).not.toHaveProperty('properties.path')
    expect(Value.Check(parameters, { action: 'open', sourcePaths: ['input/design.json'], targetPath: 'output/result.json' })).toBe(true)
    expect(Value.Check(parameters, { action: 'inspect', sourcePaths: ['input/design.json'], targetPath: 'output/result.json' })).toBe(true)
    expect(Value.Check(parameters, {})).toBe(false)
    expect(Value.Check(parameters, { action: 'index' })).toBe(false)
    expect(Value.Check(parameters, { action: 'open', path: '.' })).toBe(false)
    expect(definition.description).toContain('Main')
    expect(definition.description).toContain('inspect')
    expect(definition.description).toContain('open')
    expect(definition.description).not.toContain('绝对路径')
    expect(definition.description).not.toContain('index')
    expect(definition.description).not.toContain('search')
    expect(definition.description).not.toContain('context')
    expect(definition.description).not.toContain('confirm_alias')
    expect(definition.description).not.toContain('capabilities')

    sendToMainMock.mockClear()
    const execution = definition.execute(
      'design-call-1', { action: 'open', sourcePaths: ['input/design.json'], targetPath: 'output/result.json' } as never,
      undefined, undefined, undefined as never,
    )
    await vi.waitFor(() => expect(sendToMainMock).toHaveBeenCalledOnce())
    const request = sendToMainMock.mock.calls[0]?.[0] as {
      type: string
      requestId: string
      method: string
      payload: Record<string, unknown>
    }
    expect(request).toMatchObject({ type: 'host-tool-request', method: 'xiaogui.taskhub.design-project' })
    expect(request.payload).toMatchObject({
      attemptId: 'attempt-sdk-bootstrap',
      action: 'open',
      toolCallId: 'design-call-1',
      sourcePaths: ['input/design.json'],
      targetPath: 'output/result.json',
    })
    expect(request.payload.path).toBeUndefined()
    receiveWorkerHostToolResponse({
      type: 'host-tool-response',
      requestId: request.requestId,
      outcome: { ok: true, value: { kind: 'PI_DESIGN_PROJECT_ARTIFACT', summary: '受控项目概览' } },
    })
    await expect(execution).resolves.toMatchObject({
      content: [{ type: 'text', text: '受控项目概览' }],
      details: { kind: 'PI_DESIGN_PROJECT_ARTIFACT' },
    })

    sendToMainMock.mockClear()
    await expect(definition.execute(
      'design-call-outside', { action: 'inspect', path: '../outside' } as never,
      undefined, undefined, undefined as never,
    )).rejects.toThrow('DESIGN_PROJECT_SCOPE_MISMATCH')
    expect(sendToMainMock).not.toHaveBeenCalled()
  }
  if (mode === 'CODING') {
    writeFileSync(join(project, 'main-delete.txt'), 'delete')
    writeFileSync(join(project, 'main-rename.txt'), 'rename')
    mkdirSync(join(project, 'nested'))
    const deleteDefinition = st.session?.getToolDefinition('delete')
    const renameDefinition = st.session?.getToolDefinition('rename')
    const writeDefinition = st.session?.getToolDefinition('write')
    if (!deleteDefinition || !renameDefinition || !writeDefinition) throw new Error('CODING_V2_FILE_TOOL_MISSING')
    sendToMainMock.mockClear()
    const writing = writeDefinition.execute('write-sdk', {
      path: 'model-write.txt', content: 'written by locked Pi SDK',
    } as never, undefined, undefined, undefined as never)
    await respondToBegin('write-sdk', 'main-write.txt')
    await respondToSettle('write-sdk')
    await writing
    expect(readFileSync(join(project, 'main-write.txt'), 'utf8')).toBe('written by locked Pi SDK')

    sendToMainMock.mockClear()
    const deleting = deleteDefinition.execute('delete-sdk', { path: 'model-delete.txt' } as never, undefined, undefined, undefined as never)
    await respondToBegin('delete-sdk', 'main-delete.txt')
    await respondToSettle('delete-sdk')
    await deleting
    expect(existsSync(join(project, 'main-delete.txt'))).toBe(false)

    sendToMainMock.mockClear()
    const renaming = renameDefinition.execute('rename-sdk', {
      sourcePath: 'model-source.txt', targetPath: 'model-target.txt',
    } as never, undefined, undefined, undefined as never)
    await respondToBegin('rename-sdk', 'main-rename.txt', 'nested/main-target.txt')
    await respondToSettle('rename-sdk')
    await renaming
    expect(existsSync(join(project, 'main-rename.txt'))).toBe(false)
    expect(readFileSync(join(project, 'nested', 'main-target.txt'), 'utf8')).toBe('rename')
    clearXiaoguiPromptTurnV1()
    const executeContext = st.promptContextCandidate!
    for (const phase of ['ASK', 'PLAN'] as const) {
      st.promptContextCandidate = { ...executeContext, phase }
      prepareXiaoguiPromptTurnV1('仅查看，不执行写入')
      expect(st.session?.getActiveToolNames()).not.toContain('delete')
      expect(st.session?.getActiveToolNames()).not.toContain('rename')
      clearXiaoguiPromptTurnV1()
    }
    st.promptContextCandidate = executeContext
    prepareXiaoguiPromptTurnV1('执行文件修改')
    expect(st.session?.getActiveToolNames()).toEqual(expect.arrayContaining(['delete', 'rename']))
  }
  clearXiaoguiPromptTurnV1()
}, 30_000)

async function respondToBegin(toolCallId: string, authorizedRelativePath: string, authorizedTargetRelativePath?: string) {
  await vi.waitFor(() => expect(sendToMainMock).toHaveBeenCalledOnce())
  const request = sendToMainMock.mock.calls[0]?.[0] as { requestId: string; method: string }
  expect(request.method).toBe('xiaogui.taskhub.pi.tool.begin')
  receiveWorkerHostToolResponse({ type: 'host-tool-response', requestId: request.requestId, outcome: { ok: true, value: {
    kind: 'PI_ATTEMPT_TOOL_ALLOWED', toolCallId, authorizedRelativePath,
    ...(authorizedTargetRelativePath ? { authorizedTargetRelativePath } : {}),
  } } })
}

async function respondToSettle(toolCallId: string) {
  await vi.waitFor(() => expect(sendToMainMock).toHaveBeenCalledTimes(2))
  const request = sendToMainMock.mock.calls[1]?.[0] as { requestId: string; method: string }
  expect(request.method).toBe('xiaogui.taskhub.pi.tool.settle')
  receiveWorkerHostToolResponse({ type: 'host-tool-response', requestId: request.requestId,
    outcome: { ok: true, value: { kind: 'PI_ATTEMPT_TOOL_SETTLED', toolCallId } } })
}
