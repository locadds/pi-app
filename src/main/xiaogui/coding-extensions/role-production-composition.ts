import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import { workerManager } from '../../worker-manager'
import { sessionScopeResolverV1 } from '../scope-service'
import { getDefaultCodingAttemptPlanModuleV1 } from '../task-hub/ipc'
import { registerCodingRoleHandlersV1 } from './role-ipc'
import { CodingRoleProfileModuleV1 } from './role-profile-module'
import { createCodingRoleProductionPortsV1 } from './role-production-ports'
import { ensureDefaultCodingRoleWorkerSessionV1 } from './checkpoint-default-composition'

let defaultRoleProfiles: CodingRoleProfileModuleV1 | null = null

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
  const current = defaultRoleProfiles
  defaultRoleProfiles = null
  current?.close()
}

function getDefaultCodingRoleProfileModuleV1(): CodingRoleProfileModuleV1 {
  if (defaultRoleProfiles) return defaultRoleProfiles
  const roleDir = join(app.getPath('userData'), 'xiaogui', 'coding-roles')
  mkdirSync(roleDir, { recursive: true })
  defaultRoleProfiles = new CodingRoleProfileModuleV1({
    dbPath: join(roleDir, 'role-profiles-v1.sqlite'),
  })
  return defaultRoleProfiles
}
