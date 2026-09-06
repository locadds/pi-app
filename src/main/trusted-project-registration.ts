import Store from 'electron-store'

import { readProjectRootIdentityV2 } from './project-root-identity'
import {
  TrustedProjectRegistrationModuleV1,
  type TrustedProjectRegistrationEvidenceV1,
} from './trusted-project-registration-core'

export {
  TrustedProjectRegistrationModuleV1,
  type TrustedProjectRegistrationEvidenceV1,
  type TrustedProjectRegistrationSourceV1,
  type TrustedProjectRegistrationStoreV1,
} from './trusted-project-registration-core'

interface TrustedProjectRegistrationStoreSchemaV1 {
  projects: TrustedProjectRegistrationEvidenceV1[]
}

let persistedStore: Store<TrustedProjectRegistrationStoreSchemaV1> | null = null

function projectStore(): Store<TrustedProjectRegistrationStoreSchemaV1> {
  persistedStore ??= new Store<TrustedProjectRegistrationStoreSchemaV1>({
    name: 'pi-desktop-trusted-projects-v1',
    defaults: { projects: [] },
  })
  return persistedStore
}

export const trustedProjectRegistrationV1 = new TrustedProjectRegistrationModuleV1({
  store: {
    read: () => projectStore().get('projects') ?? [],
    write: (rows) => projectStore().set('projects', [...rows]),
  },
  readIdentity: readProjectRootIdentityV2,
  now: Date.now,
})
