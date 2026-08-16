import { createSessionScopeResolverV1 } from './scope-resolver'
import { sessionScopePersistenceV1 } from './scope-store'

/** Single main-process authority used by session lifecycle, M2 and WORK. */
export const sessionScopeResolverV1 = createSessionScopeResolverV1(sessionScopePersistenceV1)
