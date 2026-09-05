import { describe, expect, it, vi } from 'vitest'

vi.mock('./worker-execution-identity', () => ({
  canonicalWorkerProjectRootV1: (value: string) => value
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase(),
}))
vi.mock('./trusted-workspace', () => ({
  authorizeTrustedCwd: vi.fn(),
  authorizeTrustedProjectRoot: vi.fn(),
  authorizeTrustedSessionFile: vi.fn(),
}))
vi.mock('./worker-manager', () => ({ workerManager: {} }))
vi.mock('./xiaogui/scope-service', () => ({ sessionScopeResolverV1: {} }))
vi.mock('./sandbox-workspaces', () => ({
  isSandboxWorkspacePath: vi.fn(() => false),
  sandboxOwnsSessionFile: vi.fn(() => false),
}))

import {
  TrustedSessionAccessModuleV1,
} from './trusted-session-access'
import {
  createTrustedWorkerCapabilitySetV1,
  type TrustedSessionBindingHandleV1,
} from './trusted-worker-capability'

const scope = {
  projectId: `xgp1_${'1'.repeat(64)}`,
  sessionKey: `xgs1_${'2'.repeat(64)}`,
  sessionMode: 'CODING' as const,
  rootPath: 'D:/project',
  sessionFile: 'D:/sessions/a.jsonl',
}

function projectIdentity(root: string, digest: string) {
  return {
    schemaVersion: 2 as const,
    canonicalRoot: root,
    device: '1',
    inode: '2',
    birthtimeNs: '3',
    digest,
  }
}

function setup(input: {
  readonly existingSession?: boolean
  readonly sessionCwd?: string | null
  readonly rootPath?: string
  readonly sessionFile?: string
} = {}) {
  const rootPath = input.rootPath ?? 'D:/project'
  const sessionFile = input.sessionFile ?? 'D:/sessions/a.jsonl'
  const resolvedScope = { ...scope, rootPath, sessionFile }
  let digest = 'sha256:project-a'
  const capabilities = createTrustedWorkerCapabilitySetV1({
    readProjectIdentity: (root: string) => projectIdentity(root, digest),
  })
  const registered = new Map<string, TrustedSessionBindingHandleV1>()
  const rememberSessionBinding = vi.fn((binding: TrustedSessionBindingHandleV1) => {
    const snapshot = capabilities.authority.inspectSession(binding)
    registered.set(snapshot.canonicalSessionFile.toLowerCase(), binding)
  })
  const bindings = {
    rememberSessionBinding,
    resolveRegisteredSessionBinding: vi.fn((sessionFile: string) =>
      registered.get(sessionFile.toLowerCase()) ?? null),
    readLiveSessionBinding: vi.fn(() => null as {
      sessionId: string
      agentTurnActive: boolean
    } | null),
  }
  const scopeResolver = {
    resolveExisting: vi.fn(async () => resolvedScope),
    resolve: vi.fn(async () => resolvedScope),
    registerNew: vi.fn(async () => resolvedScope),
  }
  const authorizeProject = vi.fn(() => ({ ok: true as const, cwd: rootPath }))
  const authorizeFile = vi.fn(() => ({
    ok: true as const,
    cwd: rootPath,
    sessionFile,
  }))
  const sessionFileExists = vi.fn(() => input.existingSession ?? false)
  const readSessionMeta = vi.fn(() => input.existingSession
    ? { sessionId: 'session-1', cwd: input.sessionCwd ?? 'D:/project' }
    : null)
  const module = new TrustedSessionAccessModuleV1({
    authorizeProject,
    authorizeFile,
    scopeResolver: scopeResolver as never,
    bindings,
    authority: capabilities.authority,
    issuer: capabilities.issuer,
    readSessionMeta,
    sessionFileExists,
    sandboxOwnsSession: vi.fn(() => false),
  })

  return {
    module,
    capabilities,
    bindings,
    scopeResolver,
    authorizeProject,
    authorizeFile,
    sessionFileExists,
    readSessionMeta,
    replaceProject: () => { digest = 'sha256:project-b' },
  }
}

describe('TrustedSessionAccessModuleV1', () => {
  it('mints an opaque project capability only after Main cwd authorization', () => {
    const test = setup()
    const access = test.module.project({ workspaceId: 'D:/project' })

    expect(test.authorizeProject).toHaveBeenCalledWith('D:/project')
    expect(Object.keys(access.binding)).toEqual([])
    expect(access).toMatchObject({
      authorizedRoot: 'D:/project',
      projectIdentityDigest: 'sha256:project-a',
    })

    test.replaceProject()
    expect(() => test.module.inspectProject(access.binding))
      .toThrow('PROJECT_IDENTITY_CHANGED')
  })

  it('does not mint or remember a capability when explicit file authorization fails', async () => {
    const test = setup()
    test.authorizeFile.mockReturnValue({ ok: false as const, error: 'invalid_session' } as never)

    await expect(test.module.open({
      workspaceId: 'D:/project',
      sessionFile: 'D:/forged.jsonl',
    })).rejects.toThrow('invalid_session')
    expect(test.bindings.rememberSessionBinding).not.toHaveBeenCalled()
    expect(test.scopeResolver.resolveExisting).not.toHaveBeenCalled()
  })

  it('returns and registers one capability after a trusted existing-session open', async () => {
    const test = setup({ existingSession: true })
    const access = await test.module.open({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
    })

    expect(access).toMatchObject({
      ref: { rootPath: scope.rootPath, sessionFile: scope.sessionFile },
      scope,
    })
    expect(Object.keys(access.binding)).toEqual([])
    expect(test.bindings.rememberSessionBinding).toHaveBeenCalledWith(access.binding)
    expect(test.module.inspectSession(access.binding)).toEqual({
      authorizedRoot: 'D:/project',
      projectIdentityDigest: 'sha256:project-a',
      canonicalSessionFile: 'D:/sessions/a.jsonl',
    })
  })

  it('uses a registered capability for prompt access and requires the exact live Worker', async () => {
    const test = setup({ existingSession: true })

    await expect(test.module.prompt({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
    })).rejects.toThrow('trusted_session_binding_mismatch')

    const opened = await test.module.open({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
    })
    await expect(test.module.prompt({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
    })).resolves.toMatchObject({ binding: opened.binding, ref: opened.ref, scope })

    await expect(test.module.prompt({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
      requireRunningWorker: true,
    })).rejects.toThrow('trusted_running_session_required')
    test.bindings.readLiveSessionBinding.mockReturnValue({
      sessionId: 'session-1',
      agentTurnActive: true,
    })
    await expect(test.module.prompt({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
      requireRunningWorker: true,
    })).resolves.toMatchObject({ binding: opened.binding })
  })

  it('rejects Renderer selectors that do not match the registered capability', async () => {
    const test = setup({ existingSession: true })
    await test.module.open({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
    })

    await expect(test.module.prompt({
      workspaceId: 'D:/other',
      sessionFile: 'D:/sessions/a.jsonl',
    })).rejects.toThrow('trusted_session_binding_mismatch')
    await expect(test.module.prompt({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/b.jsonl',
    })).rejects.toThrow('trusted_session_binding_mismatch')
  })

  it('treats JSONL cwd as comparison-only evidence', async () => {
    const test = setup({ existingSession: true, sessionCwd: 'D:/forged-project' })

    await expect(test.module.open({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
    })).rejects.toThrow('session_workspace_mismatch')
    expect(test.bindings.rememberSessionBinding).not.toHaveBeenCalled()
  })

  it('issues a runtime session only from a live project capability and rejects path reconstruction', () => {
    const test = setup()
    const project = test.module.project({ workspaceId: 'D:/project' })
    const session = test.module.runtimeIssued({
      projectBinding: project.binding,
      sessionFile: 'D:/sessions/new.jsonl',
    })

    expect(test.bindings.rememberSessionBinding).toHaveBeenCalledWith(session)
    expect(test.module.inspectSession(session)).toEqual({
      authorizedRoot: 'D:/project',
      projectIdentityDigest: 'sha256:project-a',
      canonicalSessionFile: 'D:/sessions/new.jsonl',
    })
    expect(() => test.module.runtimeIssued({
      projectBinding: project.binding,
      sessionFile: 'relative.jsonl',
    })).toThrow('trusted_runtime_session_path_invalid')

    test.replaceProject()
    expect(() => test.module.runtimeIssued({
      projectBinding: project.binding,
      sessionFile: 'D:/sessions/replacement.jsonl',
    })).toThrow('PROJECT_IDENTITY_CHANGED')
  })

  it.each([
    ['ordinary project', 'D:/project', 'D:/sessions/new-project.jsonl'],
    [
      'managed sandbox',
      'D:/app/sandbox-workspaces/sandbox-a',
      'D:/sessions/new-sandbox.jsonl',
    ],
  ])('allows a %s first prompt before the new JSONL is materialized', async (
    _label,
    rootPath,
    sessionFile,
  ) => {
    const test = setup({ rootPath, sessionFile, existingSession: false })
    const project = test.module.project({ workspaceId: rootPath })
    const binding = test.module.runtimeIssued({
      projectBinding: project.binding,
      sessionFile,
    })

    await expect(test.module.prompt({ workspaceId: rootPath, sessionFile }))
      .resolves.toMatchObject({ binding, ref: { rootPath, sessionFile } })
    expect(test.readSessionMeta).not.toHaveBeenCalled()
  })

  it('invalidates a materialized binding if its JSONL disappears', async () => {
    const test = setup({ existingSession: true })
    const opened = await test.module.open({
      workspaceId: 'D:/project',
      sessionFile: 'D:/sessions/a.jsonl',
    })
    test.sessionFileExists.mockReturnValue(false)

    expect(() => test.module.inspectSession(opened.binding))
      .toThrow('trusted_session_metadata_missing')
  })

  it('reissues persisted evidence only after Main revalidates the current project identity', async () => {
    const test = setup({ existingSession: true })

    const access = await test.module.reissuePersisted({
      authorizedRoot: 'D:/project',
      projectIdentityDigest: 'sha256:project-a',
      sessionFile: 'D:/sessions/a.jsonl',
    })

    expect(test.bindings.rememberSessionBinding).toHaveBeenCalledOnce()
    expect(test.bindings.rememberSessionBinding).toHaveBeenCalledWith(access.binding)
    expect(test.module.inspectSession(access.binding)).toMatchObject({
      authorizedRoot: 'D:/project',
      projectIdentityDigest: 'sha256:project-a',
      canonicalSessionFile: 'D:/sessions/a.jsonl',
    })
  })

  it('does not register a capability when persisted project evidence is stale', async () => {
    const test = setup({ existingSession: true })

    await expect(test.module.reissuePersisted({
      authorizedRoot: 'D:/project',
      projectIdentityDigest: 'sha256:stale-project',
      sessionFile: 'D:/sessions/a.jsonl',
    })).rejects.toThrow('PROJECT_IDENTITY_CHANGED')

    expect(test.bindings.rememberSessionBinding).not.toHaveBeenCalled()
    expect(test.scopeResolver.resolveExisting).not.toHaveBeenCalled()
  })
})
