import { describe, expect, it, vi } from 'vitest'

vi.mock('./worker-execution-identity', () => ({
  canonicalWorkerProjectRootV1: (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(),
}))
vi.mock('./trusted-workspace', () => ({ authorizeTrustedSessionFile: vi.fn() }))
vi.mock('./worker-manager', () => ({ workerManager: {} }))
vi.mock('./xiaogui/scope-service', () => ({ sessionScopeResolverV1: {} }))

import { TrustedSessionAccessModuleV1 } from './trusted-session-access'

const scope = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
  sessionMode: 'CODING' as const,
  rootPath: 'D:/project',
  sessionFile: 'D:/sessions/new.jsonl',
}

describe('TrustedSessionAccessModuleV1', () => {
  it('does not create a Main binding when file authorization fails', async () => {
    const rememberSessionWorkspace = vi.fn()
    const module = new TrustedSessionAccessModuleV1({
      authorizeFile: vi.fn(() => ({ ok: false as const, error: 'invalid_session' })),
      scopeResolver: {
        resolveExisting: vi.fn(),
        resolve: vi.fn(),
        registerNew: vi.fn(),
      } as never,
      bindings: {
        rememberSessionWorkspace,
        resolveRegisteredSessionWorkspaceCwd: vi.fn(),
        readLiveSessionBinding: vi.fn(),
      },
    })

    await expect(module.open({ workspaceId: 'D:/project', sessionFile: 'D:/forged.jsonl' }))
      .rejects.toThrow('invalid_session')
    expect(rememberSessionWorkspace).not.toHaveBeenCalled()
  })

  it('allows a not-yet-materialized new project or Sandbox session only from Main registration', async () => {
    const resolveExisting = vi.fn(async () => scope)
    const module = new TrustedSessionAccessModuleV1({
      authorizeFile: vi.fn(),
      scopeResolver: {
        resolveExisting,
        resolve: vi.fn(),
        registerNew: vi.fn(),
      } as never,
      bindings: {
        rememberSessionWorkspace: vi.fn(),
        resolveRegisteredSessionWorkspaceCwd: vi.fn((sessionFile: string) =>
          sessionFile.includes('sandbox') ? 'D:/private/sandbox-1' : 'D:/project'),
        readLiveSessionBinding: vi.fn(),
      },
    })

    await expect(module.prompt({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/new.jsonl',
    })).resolves.toMatchObject({ ref: { rootPath: 'D:/project' } })
    await expect(module.prompt({
      workspaceId: 'D:/private/sandbox-1',
      sessionFile: 'D:/sessions/sandbox-new.jsonl',
    })).resolves.toMatchObject({ ref: { rootPath: 'D:/private/sandbox-1' } })
    expect(resolveExisting).toHaveBeenCalledTimes(2)
  })

  it('rejects renderer-only cold binding and requires an exact active Worker for steer/followUp', async () => {
    const readLiveSessionBinding = vi.fn(() => ({ sessionId: 'session-1', agentTurnActive: false }))
    const bindings = {
      rememberSessionWorkspace: vi.fn(),
      resolveRegisteredSessionWorkspaceCwd: vi.fn(() => null as string | null),
      readLiveSessionBinding,
    }
    const module = new TrustedSessionAccessModuleV1({
      authorizeFile: vi.fn(),
      scopeResolver: {
        resolveExisting: vi.fn(async () => scope),
        resolve: vi.fn(),
        registerNew: vi.fn(),
      } as never,
      bindings,
    })

    await expect(module.prompt({ workspaceId: 'D:/project', sessionFile: 'D:/sessions/old.jsonl' }))
      .rejects.toThrow('trusted_session_binding_mismatch')
    bindings.resolveRegisteredSessionWorkspaceCwd.mockReturnValue('D:/project')
    await expect(module.prompt({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/old.jsonl',
      requireRunningWorker: true,
    })).rejects.toThrow('trusted_running_session_required')
    readLiveSessionBinding.mockReturnValue({ sessionId: 'session-1', agentTurnActive: true })
    await expect(module.prompt({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/old.jsonl',
      requireRunningWorker: true,
    })).resolves.toMatchObject({ scope })
  })
})
