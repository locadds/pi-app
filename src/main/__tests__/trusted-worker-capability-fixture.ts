import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import type { ProjectRootIdentityV2 } from '../project-root-identity'
import {
  createTrustedWorkerCapabilitySetV1,
  type TrustedProjectBindingHandleV1,
  type TrustedSessionBindingHandleV1,
} from '../trusted-worker-capability'

function projectIdentity(root: string): ProjectRootIdentityV2 {
  const canonicalRoot = resolve(root).replace(/\\/g, '/')
  const digest = `sha256:${createHash('sha256').update(canonicalRoot).digest('hex')}`
  return Object.freeze({
    schemaVersion: 2,
    canonicalRoot,
    device: 'test-device',
    inode: digest.slice(-16),
    birthtimeNs: '1',
    digest,
  })
}

/** Isolated Main authority domain for tests; no production capability can enter it. */
export function createTrustedWorkerCapabilityFixtureV1() {
  const capabilities = createTrustedWorkerCapabilitySetV1({
    readProjectIdentity: projectIdentity,
  })

  const issueProject = (root: string): TrustedProjectBindingHandleV1 =>
    capabilities.issuer.issueProject(root)

  const issueSession = (
    root: string,
    sessionFile: string,
  ): TrustedSessionBindingHandleV1 => {
    const project = issueProject(root)
    return capabilities.issuer.issueSession(project, sessionFile)
  }

  return Object.freeze({
    authority: capabilities.authority,
    issuer: capabilities.issuer,
    issueProject,
    issueSession,
    projectIdentity,
  })
}
