import type { AppEvent } from '@shared/app-events'
import { parseXiaoguiPromptContextV1 } from '@shared/xiaogui-prompt-contract'
import { XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1 } from '@shared/xiaogui-prompt-matrix'
import { workerPromptContextToolNamesForModeV1 } from '@shared/xiaogui-prompt-capabilities'
import type { RuntimeScopeBindingV1 } from '@shared/xiaogui-agent-runtime'
import { createTrustedWorkerCapabilitySetV1 } from '../../trusted-worker-capability'
import { WorkerManager } from '../../worker-manager'
import type { WorkerHostToolRequestHandler } from '../../worker-manager-types'
import { getAgentRuntimeConfig } from '../../wsl/runtime-config'

export interface PiAttemptWorkerPortV1 {
  start(): Promise<{ sessionId: string; sessionFile: string; model: string }>
  setModel(provider: string, model: string): Promise<string>
  prompt(text: string): Promise<void>
  abort(): Promise<void>
  close(): Promise<void>
}

/** Main-only Adapter over the existing Pi Worker pool/SDK; no second Agent loop. */
export function createPiAttemptWorkerPortV1(input: {
  rootPath: string
  scope: RuntimeScopeBindingV1
  designExtensionPath?: string
  onTool: WorkerHostToolRequestHandler
  onEvent: (event: AppEvent) => void
  onExit: () => void
}): PiAttemptWorkerPortV1 {
  // This candidate supports the already verified Windows Host, not an implicit
  // WSL-to-host substitution. Never reinterpret an existing runtime selection.
  if (getAgentRuntimeConfig().mode !== 'host') throw new Error('PI_ATTEMPT_HOST_REQUIRED')
  const capabilities = createTrustedWorkerCapabilitySetV1()
  const project = capabilities.issuer.issueProject(input.rootPath)
  const context = parseXiaoguiPromptContextV1({
    schemaVersion: 1, mode: input.scope.sessionMode, phase: 'EXECUTE',
    workspaceAvailable: true, projectTrusted: true,
    projectId: input.scope.projectId, sessionKey: input.scope.sessionKey,
    enabledCapabilities: input.scope.sessionMode === 'DESIGN' ? ['design.analysis'] : [...XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1[input.scope.sessionMode]],
    availableToolNames: [...workerPromptContextToolNamesForModeV1(input.scope.sessionMode)],
  })
  const manager = new WorkerManager({
    forWorkspace: async () => context,
    forSession: async () => context,
  }, capabilities.authority, {
    attemptId: input.scope.attemptId, designExtensionPath: input.designExtensionPath, onEvent: input.onEvent, onExit: input.onExit,
  })
  manager.setHostToolRequestHandler(input.onTool)
  let sessionFile = ''
  return {
    async start() {
      const result = await manager.start(project)
      capabilities.authority.inspectProject(project)
      const state = await manager.getState()
      sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : ''
      if (!sessionFile || !result.sessionId) throw new Error('PI_ATTEMPT_SESSION_NOT_READY')
      return { sessionId: result.sessionId, sessionFile, model: result.model ?? '' }
    },
    setModel: (provider, model) => manager.setModel(provider, model),
    async prompt(text) {
      capabilities.authority.inspectProject(project)
      await manager.sendPrompt(text)
    },
    async abort() {
      // Bootstrap slots are keyed by workspace until registered, so use the
      // same live RPC target rather than creating/loading a session to cancel.
      await manager.abortCurrentAttempt()
    },
    close: () => manager.stop(),
  }
}
