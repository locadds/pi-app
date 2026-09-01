import { workerManager } from '../../worker-manager'
import { sessionScopeResolverV1 } from '../scope-service'
import {
  getDefaultCodingAttemptPlanModuleV1,
  getDefaultCodingRoleProfileModuleV1,
} from '../task-hub/ipc'
import { registerCodingRoleHandlersV1 } from './role-ipc'
import { createCodingRoleProductionPortsV1 } from './role-production-ports'
import { ensureDefaultCodingRoleWorkerSessionV1 } from './checkpoint-default-composition'

export function registerDefaultCodingRoleHandlersV1(): void {
  const ports = createCodingRoleProductionPortsV1({
    lookup: sessionScopeResolverV1,
    plans: getDefaultCodingAttemptPlanModuleV1(),
    workers: workerManager,
    ensureSession: ensureDefaultCodingRoleWorkerSessionV1,
  })
  registerCodingRoleHandlersV1({
    roles: getDefaultCodingRoleProfileModuleV1(),
    ...ports,
  })
}

export function closeDefaultCodingRoleProfileModuleV1(): void {
  // The TaskHub runtime composition owns and closes the shared role store.
}
