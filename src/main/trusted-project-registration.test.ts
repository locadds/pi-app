import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  projectRootComparisonKeyV2,
  readProjectRootIdentityV2,
} from './project-root-identity'
import { TrustedProjectRegistrationModuleV1 } from './trusted-project-registration-core'

function identity(root: string, digest: string) {
  return {
    schemaVersion: 2 as const,
    canonicalRoot: root,
    device: '1',
    inode: '2',
    birthtimeNs: '3',
    digest,
  }
}

function availableWslTempRoot(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const distro = execFileSync('wsl.exe', ['-l', '-q'])
      .toString('utf16le')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean)
    if (!distro) return null
    execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-lc', 'mkdir -p /tmp'])
    const tempRoot = `\\\\wsl.localhost\\${distro}\\tmp`
    return existsSync(tempRoot) ? tempRoot : null
  } catch {
    return null
  }
}

const wslTempRoot = availableWslTempRoot()

describe('TrustedProjectRegistrationModuleV1', () => {
  it('does not treat renderer preferences as project authority', () => {
    const rows: Array<{
      schemaVersion: 1
      canonicalRoot: string
      projectIdentityDigest: string
      source: 'NATIVE_DIRECTORY_PICKER' | 'MANAGED_SANDBOX'
      registeredAt: number
    }> = []
    const module = new TrustedProjectRegistrationModuleV1({
      store: {
        read: () => rows,
        write: (next) => {
          rows.splice(0, rows.length, ...next)
        },
      },
      readIdentity: (root) => identity(root, `sha256:${root}`),
      now: () => 10,
    })

    expect(module.authorize('/renderer/current-project')).toEqual({
      ok: false,
      error: 'trusted_project_open_required',
    })

    expect(module.register('/native/project', 'NATIVE_DIRECTORY_PICKER')).toEqual({
      ok: true,
      cwd: '/native/project',
    })
    expect(module.authorize('/native/project')).toEqual({
      ok: true,
      cwd: '/native/project',
    })
  })

  it('treats stored registration as evidence and rejects same-path replacement', () => {
    let digest = 'sha256:first'
    const rows: Array<{
      schemaVersion: 1
      canonicalRoot: string
      projectIdentityDigest: string
      source: 'NATIVE_DIRECTORY_PICKER' | 'MANAGED_SANDBOX'
      registeredAt: number
    }> = []
    const module = new TrustedProjectRegistrationModuleV1({
      store: {
        read: () => rows,
        write: (next) => {
          rows.splice(0, rows.length, ...next)
        },
      },
      readIdentity: (root) => identity(root, digest),
      now: () => 10,
    })

    module.register('/native/project', 'NATIVE_DIRECTORY_PICKER')
    digest = 'sha256:replacement'

    expect(module.authorize('/native/project')).toEqual({
      ok: false,
      error: 'PROJECT_IDENTITY_CHANGED',
    })
  })

  it.skipIf(!wslTempRoot)(
    'preserves a real mixed-case WSL execution cwd through native project registration',
    () => {
      const wslRoot = mkdtempSync(join(wslTempRoot!, 'XiaoguiCaseRoot-'))
      const rows: Array<{
        schemaVersion: 1
        canonicalRoot: string
        projectIdentityDigest: string
        source: 'NATIVE_DIRECTORY_PICKER' | 'MANAGED_SANDBOX'
        registeredAt: number
      }> = []
      try {
        const module = new TrustedProjectRegistrationModuleV1({
          store: {
            read: () => rows,
            write: (next) => {
              rows.splice(0, rows.length, ...next)
            },
          },
          readIdentity: readProjectRootIdentityV2,
          now: () => 10,
        })
        const expectedExecutionRoot = realpathSync.native(wslRoot).replace(/\\/g, '/')
        const expectedLeaf = expectedExecutionRoot.split('/').at(-1)!

        expect(module.register(wslRoot, 'NATIVE_DIRECTORY_PICKER')).toEqual({
          ok: true,
          cwd: expectedExecutionRoot,
        })
        const authorized = module.authorize(wslRoot)
        expect(authorized).toEqual({ ok: true, cwd: expectedExecutionRoot })
        expect(existsSync(authorized.ok ? authorized.cwd : '')).toBe(true)
        expect(projectRootComparisonKeyV2(expectedExecutionRoot)).toContain(`/${expectedLeaf}`)
      } finally {
        rmSync(wslRoot, { recursive: true, force: true })
      }
    },
  )
})
