import { describe, expect, it, vi } from 'vitest'

import type { PiSessionScopeV1 } from './scope-derive'
import { createXiaoguiPromptContextResolverV1 } from './prompt-context'

const scope: PiSessionScopeV1 = {
  rootPath: 'D:/project',
  sessionFile: 'D:/sessions/one.jsonl',
  projectId: 'xgp1_project' as PiSessionScopeV1['projectId'],
  sessionKey: 'xgs1_session' as PiSessionScopeV1['sessionKey'],
  sessionMode: 'CODING',
}

describe('Main Xiaogui Prompt Context Resolver V1', () => {
  it('uses canonical Session Scope and current Phase without exposing paths', async () => {
    const resolve = vi.fn(async () => scope)
    const resolver = createXiaoguiPromptContextResolverV1({
      resolveScope: resolve,
      getMode: () => 'WORK',
      getPhase: () => 'PLAN',
      workspaceExists: () => true,
      projectTrusted: () => true,
      deriveProjectId: () => scope.projectId,
    })

    const result = await resolver.forSession(scope.rootPath, scope.sessionFile)

    expect(resolve).toHaveBeenCalledWith({ rootPath: scope.rootPath, sessionFile: scope.sessionFile })
    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'CODING',
      phase: 'PLAN',
      workspaceAvailable: true,
      projectTrusted: true,
      projectId: 'xgp1_project',
      sessionKey: 'xgs1_session',
      enabledCapabilities: ['coding.workspace'],
    })
    expect(JSON.stringify(result)).not.toContain('D:/project')
    expect(JSON.stringify(result)).not.toContain('D:/sessions')
  })

  it('creates a pre-file Context for new Session and never invents a sessionKey', async () => {
    const resolver = createXiaoguiPromptContextResolverV1({
      resolveScope: vi.fn(async () => scope),
      getMode: () => 'WORK',
      getPhase: () => 'EXECUTE',
      workspaceExists: () => true,
      projectTrusted: () => true,
      deriveProjectId: () => scope.projectId,
    })

    expect(await resolver.forWorkspace('D:/project', 'DESIGN')).toMatchObject({
      mode: 'DESIGN',
      phase: 'EXECUTE',
      projectId: 'xgp1_project',
      enabledCapabilities: ['design.analysis'],
    })
    expect((await resolver.forWorkspace('D:/project', 'DESIGN')).sessionKey).toBeUndefined()
  })
})
