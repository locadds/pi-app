import { app } from 'electron'
import { join } from 'node:path'

import { configStore } from '../../config-store'
import { workerManager } from '../../worker-manager'
import { xiaogui } from '../sidecar-bridge'
import { sessionScopeResolverV1 } from '../scope-service'
import type { SessionAddressV1 } from '@shared/xiaogui-session-scope'
import { DirectCodingModuleV2 } from './direct-coding-module'
import { registerDirectCodingCheckpointHandlersV2 } from './direct-coding-checkpoint-ipc'
import { createDirectCodingWorkerToolHandlerV2 } from './direct-coding-worker-tool'
import { getDefaultCodingAuthorizationModuleV2 } from '../task-hub/ipc'

let composition: ReturnType<typeof createDefaultDirectCodingCompositionV2> | null = null

export function getDefaultDirectCodingCompositionV2() {
  composition ??= createDefaultDirectCodingCompositionV2()
  return composition
}

function createDefaultDirectCodingCompositionV2() {
  const module = new DirectCodingModuleV2({
    dbPath: join(app.getPath('userData'), 'xiaogui-task-hub-m2a.sqlite'),
    authorization: getDefaultCodingAuthorizationModuleV2(),
  })
  return Object.freeze({
    module,
    workerHandler: createDirectCodingWorkerToolHandlerV2({
      module,
      scopeResolver: sessionScopeResolverV1,
      readPhase: () => xiaogui.getExecutionPhase(),
      readMode: () => configStore.get('xiaoguiCodingPermissionMode'),
    }),
    registerCheckpointHandlers: () => registerDirectCodingCheckpointHandlersV2({
      module,
      scope: sessionScopeResolverV1,
      resolveCurrentRoot: resolveCurrentDirectCodingRootV2,
    }),
    close: () => module.close(),
  })
}

async function resolveCurrentDirectCodingRootV2(
  address: SessionAddressV1,
): Promise<string | null> {
  let matchedRoot: string | null = null
  for (const runtime of workerManager.listSessionRuntime()) {
    const scope = await sessionScopeResolverV1.resolveExisting({
      rootPath: runtime.cwd,
      sessionFile: runtime.sessionFile,
    })
    if (
      !scope ||
      scope.sessionMode !== 'CODING' ||
      scope.projectId !== address.projectId ||
      scope.sessionKey !== address.sessionKey
    ) continue
    if (matchedRoot !== null && matchedRoot !== scope.rootPath) return null
    matchedRoot = scope.rootPath
  }
  return matchedRoot
}

export function closeDefaultDirectCodingCompositionV2(): void {
  composition?.close()
  composition = null
}
