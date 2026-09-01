import { describe, expect, it } from 'vitest'

import { createHubTaskWorkerCredentialsV1 } from './worker-credentials'

function bundle() {
  return {
    endpoint: 'http://hub.intranet:3000',
    accessToken: 'access-token-that-is-never-rendered-or-logged',
    node: {
      subjectId: 'xgh_subject_1',
      nodeId: 'xgh_node_1',
      keyId: 'ed25519:key_1',
      deviceToken: 'node-token-that-is-never-rendered',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nprivate-key-never-rendered\n-----END PRIVATE KEY-----',
    },
  }
}

describe('HubTaskWorkerCredentialsV1', () => {
  it('writes one encrypted-record payload and returns no bundle when that record is malformed', () => {
    let raw: string | null = null
    const credentials = createHubTaskWorkerCredentialsV1({
      read: () => raw,
      write: (value) => {
        raw = value
        return true
      },
      clear: () => {
        raw = null
      },
    })

    expect(credentials.write(bundle())).toBe(true)
    expect(raw).toContain('private-key-never-rendered')
    expect(credentials.read()).toEqual(bundle())

    raw = '{"version":1,"endpoint":"http://hub.intranet:3000"}'
    expect(credentials.read()).toBeNull()
  })

  it('fails closed when encrypted storage refuses the write', () => {
    const credentials = createHubTaskWorkerCredentialsV1({
      read: () => null,
      write: () => false,
      clear: () => undefined,
    })

    expect(credentials.write(bundle())).toBe(false)
    expect(credentials.read()).toBeNull()
  })
})
