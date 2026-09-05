import type { CodingContextAgentPayloadV1 } from '@shared/xiaogui-coding-extension-pack'

import { sessionScopeResolverV1 } from '../scope-service'
import { MainProjectWorkspaceResolverV1 } from '../task-hub/project-workspace-resolver'
import { CodingContextModuleV1 } from './context-module'

export const codingContextModuleV1 = new CodingContextModuleV1({
  projectResolver: new MainProjectWorkspaceResolverV1(),
  scopeLookup: sessionScopeResolverV1,
})

export async function resolveCodingContextForPromptV1(
  input: {
    readonly authorizedRoot: string
    readonly sessionFile: string
    readonly snapshotIds: readonly string[] | undefined
  },
): Promise<CodingContextAgentPayloadV1 | undefined> {
  if (!input.snapshotIds?.length) return undefined
  if (!input.authorizedRoot || !input.sessionFile) {
    throw new Error('CODING_CONTEXT_SESSION_REQUIRED')
  }
  const scope = await sessionScopeResolverV1.resolveExisting({
    rootPath: input.authorizedRoot,
    sessionFile: input.sessionFile,
  })
  if (!scope || scope.sessionMode !== 'CODING') {
    throw new Error('CODING_CONTEXT_SESSION_SCOPE_MISMATCH')
  }
  return codingContextModuleV1.resolveForAgent({
    projectId: scope.projectId,
    sessionKey: scope.sessionKey,
  }, input.snapshotIds)
}
