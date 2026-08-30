import {
  XIAOGUI_PROMPT_CONTRACT_SCHEMA_VERSION_V1,
  parseXiaoguiPromptContextV1,
  type XiaoguiMode,
  type XiaoguiPromptContextV1,
} from '@shared/xiaogui-prompt-contract'
import {
  workerPromptContextBaselineToolNamesV1,
  XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1,
} from '@shared/xiaogui-prompt-matrix'

import type { PiSessionRefV1, PiSessionScopeV1 } from './scope-derive'

export interface XiaoguiPromptContextResolverV1 {
  forWorkspace(cwd: string, requestedMode?: XiaoguiMode): Promise<XiaoguiPromptContextV1>
  forSession(cwd: string, sessionFile: string): Promise<XiaoguiPromptContextV1>
}

export interface XiaoguiPromptContextResolverDepsV1 {
  readonly resolveScope: (ref: PiSessionRefV1) => Promise<PiSessionScopeV1>
  readonly getMode: () => XiaoguiMode
  readonly getPhase: () => XiaoguiPromptContextV1['phase']
  readonly workspaceExists: (cwd: string) => boolean
  readonly projectTrusted: (cwd: string) => boolean
  readonly deriveProjectId: (cwd: string) => XiaoguiPromptContextV1['projectId']
}

function contextFor(
  deps: XiaoguiPromptContextResolverDepsV1,
  cwd: string,
  mode: XiaoguiMode,
  ids: Pick<XiaoguiPromptContextV1, 'projectId' | 'sessionKey'>,
): XiaoguiPromptContextV1 {
  return parseXiaoguiPromptContextV1({
    schemaVersion: XIAOGUI_PROMPT_CONTRACT_SCHEMA_VERSION_V1,
    mode,
    phase: deps.getPhase(),
    workspaceAvailable: deps.workspaceExists(cwd),
    projectTrusted: deps.projectTrusted(cwd),
    enabledCapabilities: [...XIAOGUI_DEFAULT_CAPABILITIES_BY_MODE_V1[mode]],
    availableToolNames: [...workerPromptContextBaselineToolNamesV1()],
    ...ids,
  })
}

export function createXiaoguiPromptContextResolverV1(
  deps: XiaoguiPromptContextResolverDepsV1,
): XiaoguiPromptContextResolverV1 {
  return {
    async forWorkspace(cwd, requestedMode) {
      return contextFor(deps, cwd, requestedMode ?? deps.getMode(), {
        projectId: deps.deriveProjectId(cwd),
        sessionKey: undefined,
      })
    },
    async forSession(cwd, sessionFile) {
      const scope = await deps.resolveScope({ rootPath: cwd, sessionFile })
      return contextFor(deps, cwd, scope.sessionMode, {
        projectId: scope.projectId,
        sessionKey: scope.sessionKey,
      })
    },
  }
}
