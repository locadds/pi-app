import { describe, expect, it } from 'vitest'

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
})
