import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sandboxRoot = join(tmpdir(), `pi-trusted-workspace-${process.pid}`)

const mocks = vi.hoisted(() => ({
  cwd: '/workspace' as string | null,
  currentProject: null as string | null,
  recentProjects: [] as string[],
  registeredProjects: new Set<string>(),
  sandboxPath: '' as string,
  sandboxOwnsSession: false,
  sandboxBinding: null as string | null,
  runtime: { mode: 'host' as 'host' | 'wsl', distro: null as string | null },
  readSessionMetaFromFile: vi.fn(),
}))

vi.mock('../worker-manager', () => ({
  workerManager: {
    get cwd() {
      return mocks.cwd
    },
  },
}))

vi.mock('../config-store', () => ({
  configStore: {
    get: vi.fn((key: string) => key === 'currentProject' ? mocks.currentProject : mocks.recentProjects),
  },
}))

vi.mock('../sandbox-workspaces', () => ({
  findSandboxWorkspaceForSessionFile: vi.fn(() => mocks.sandboxBinding),
  isSandboxWorkspacePath: vi.fn((path: string) => path === mocks.sandboxPath),
  sandboxOwnsSessionFile: vi.fn(() => mocks.sandboxOwnsSession),
}))

vi.mock('../wsl/runtime-config', () => ({
  getAgentRuntimeConfig: () => mocks.runtime,
}))

vi.mock('../session-file-meta', () => ({
  readSessionMetaFromFile: mocks.readSessionMetaFromFile,
}))

vi.mock('../trusted-project-registration', () => ({
  trustedProjectRegistrationV1: {
    authorize: vi.fn((path: string | undefined) => {
      const candidate = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '')
      const key = /^[a-zA-Z]:\//.test(candidate) ? candidate.toLowerCase() : candidate
      const found = [...mocks.registeredProjects].find((registered) => {
        const normalized = registered.replace(/\\/g, '/').replace(/\/+$/, '')
        const registeredKey = /^[a-zA-Z]:\//.test(normalized)
          ? normalized.toLowerCase()
          : normalized
        return registeredKey === key
      })
      return found
        ? { ok: true as const, cwd: found }
        : { ok: false as const, error: 'trusted_project_open_required' }
    }),
    register: vi.fn(),
    revoke: vi.fn(),
  },
}))

import { authorizeTrustedSessionFile } from '../trusted-workspace'

describe('authorizeTrustedSessionFile', () => {
  beforeEach(() => {
    mocks.cwd = '/workspace'
    mocks.currentProject = null
    mocks.recentProjects = []
    mocks.registeredProjects = new Set(['/workspace'])
    mocks.sandboxPath = join(sandboxRoot, 'managed')
    mocks.sandboxOwnsSession = false
    mocks.sandboxBinding = null
    mkdirSync(mocks.sandboxPath, { recursive: true })
    mocks.runtime = { mode: 'host', distro: null }
    mocks.readSessionMetaFromFile.mockReset()
    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-a', cwd: '/workspace' })
  })

  afterEach(() => rmSync(sandboxRoot, { recursive: true, force: true }))

  it('accepts an absolute session whose header belongs to the active workspace', () => {
    expect(authorizeTrustedSessionFile('/workspace', '/sessions/a.jsonl')).toEqual({
      ok: true,
      cwd: '/workspace',
      sessionFile: '/sessions/a.jsonl',
    })
  })

  it('rejects another workspace, a relative path, and a mismatched session header', () => {
    expect(authorizeTrustedSessionFile('/other', '/sessions/a.jsonl')).toEqual({
      ok: false,
      error: 'trusted_project_open_required',
    })
    expect(authorizeTrustedSessionFile('/workspace', 'session.jsonl')).toEqual({
      ok: false,
      error: 'invalid_session_path',
    })

    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-b', cwd: '/other' })
    expect(authorizeTrustedSessionFile('/workspace', '/sessions/b.jsonl')).toEqual({
      ok: false,
      error: 'session_workspace_mismatch',
    })
  })

  it('does not trust a recent-project preference until Main registered it', () => {
    mocks.recentProjects = ['/background']
    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-b', cwd: '/background' })
    expect(authorizeTrustedSessionFile('/background', '/sessions/background.jsonl')).toEqual({
      ok: false,
      error: 'trusted_project_open_required',
    })

    mocks.registeredProjects.add('/background')
    expect(authorizeTrustedSessionFile('/background', '/sessions/background.jsonl')).toEqual({
      ok: true,
      cwd: '/background',
      sessionFile: '/sessions/background.jsonl',
    })

    mocks.registeredProjects.add(mocks.sandboxPath)
    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-s', cwd: mocks.sandboxPath })
    expect(authorizeTrustedSessionFile(mocks.sandboxPath, '/sessions/sandbox.jsonl')).toEqual(
      expect.objectContaining({ ok: true, cwd: mocks.sandboxPath }),
    )

    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-e', cwd: '/evil' })
    expect(authorizeTrustedSessionFile('/evil', '/sessions/evil.jsonl')).toEqual({
      ok: false,
      error: 'trusted_project_open_required',
    })
  })

  it('accepts a stale Session header only when private sandbox metadata owns that exact file', () => {
    mocks.registeredProjects.add(mocks.sandboxPath)
    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-s', cwd: '/legacy' })
    expect(authorizeTrustedSessionFile(mocks.sandboxPath, '/sessions/sandbox.jsonl')).toEqual({
      ok: false,
      error: 'session_workspace_mismatch',
    })

    mocks.sandboxOwnsSession = true
    expect(authorizeTrustedSessionFile(mocks.sandboxPath, '/sessions/sandbox.jsonl')).toEqual({
      ok: true,
      cwd: mocks.sandboxPath,
      sessionFile: '/sessions/sandbox.jsonl',
    })

    mocks.sandboxOwnsSession = false
    mocks.sandboxBinding = mocks.sandboxPath
    expect(authorizeTrustedSessionFile('/legacy', '/sessions/sandbox.jsonl')).toEqual({
      ok: true,
      cwd: mocks.sandboxPath,
      sessionFile: '/sessions/sandbox.jsonl',
    })
  })

  it('matches Windows workspace paths case-insensitively', () => {
    mocks.cwd = 'C:\\Project'
    mocks.registeredProjects.add(mocks.cwd)
    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-a', cwd: 'c:\\project' })

    expect(authorizeTrustedSessionFile(mocks.cwd, 'C:\\sessions\\a.jsonl')).toEqual(
      expect.objectContaining({ ok: true }),
    )
  })

  it('authorizes WSL session headers against their Windows workspace view', () => {
    mocks.cwd = 'C:\\project'
    mocks.registeredProjects.add(mocks.cwd)
    mocks.runtime = { mode: 'wsl', distro: 'Ubuntu' }
    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-a', cwd: '/mnt/c/project' })

    expect(
      authorizeTrustedSessionFile(
        mocks.cwd,
        '\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi\\agent\\sessions\\a.jsonl',
      ),
    ).toEqual(expect.objectContaining({ ok: true, cwd: mocks.cwd }))
  })

  it('rejects a WSL session from a distro other than the active runtime', () => {
    mocks.cwd = 'C:\\project'
    mocks.registeredProjects.add(mocks.cwd)
    mocks.runtime = { mode: 'wsl', distro: 'Ubuntu' }
    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-a', cwd: '/mnt/c/project' })

    expect(
      authorizeTrustedSessionFile(
        mocks.cwd,
        '\\\\wsl.localhost\\Debian\\home\\u\\.pi\\agent\\sessions\\a.jsonl',
      ),
    ).toEqual({ ok: false, error: 'session_workspace_mismatch' })
  })

  it('matches native WSL header paths but rejects another session-file distro', () => {
    mocks.cwd = '\\\\wsl.localhost\\Ubuntu\\home\\u\\project'
    mocks.registeredProjects.add(mocks.cwd)
    mocks.readSessionMetaFromFile.mockReturnValue({ sessionId: 'session-a', cwd: '/home/u/project' })

    expect(
      authorizeTrustedSessionFile(
        mocks.cwd,
        '\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi\\agent\\sessions\\a.jsonl',
      ),
    ).toEqual(expect.objectContaining({ ok: true }))
    expect(
      authorizeTrustedSessionFile(
        mocks.cwd,
        '\\\\wsl.localhost\\Debian\\home\\u\\.pi\\agent\\sessions\\a.jsonl',
      ),
    ).toEqual({ ok: false, error: 'session_workspace_mismatch' })
  })
})
