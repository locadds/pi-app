import { app } from 'electron'

import { createHttpXiaoguiHubTaskWorkerPortV1 } from './http-task-worker-port'
import { createHubTaskWorkerCredentialsV1 } from './worker-credentials'
import { createPersistentHubTaskWorkerStateStoreV1 } from './worker-persistence'
import {
  createHubTaskWorkerServiceV1,
  type HubTaskWorkerServiceV1,
} from './worker-service'
import { getDefaultCollaborationHubApplication } from '../task-hub/ipc'
import { installationIdDigestV1 } from './worker-installation'

let defaultService: HubTaskWorkerServiceV1 | null = null

export function getDefaultHubTaskWorkerServiceV1(): HubTaskWorkerServiceV1 {
  if (defaultService) return defaultService
  const service = createHubTaskWorkerServiceV1({
    state: createPersistentHubTaskWorkerStateStoreV1(),
    credentials: createHubTaskWorkerCredentialsV1(),
    application: getDefaultCollaborationHubApplication(),
    createPort: (credentials) =>
      createHttpXiaoguiHubTaskWorkerPortV1({
        endpoint: credentials.endpoint,
        accessToken: credentials.accessToken,
        ...('node' in credentials ? { node: { deviceToken: credentials.node.deviceToken } } : {}),
      }),
  })
  defaultService = service
  return service
}

/**
 * A stable one-way installation discriminator. The real userData path remains
 * in the main process and is never sent to the Hub or Renderer.
 */
export function getDefaultHubTaskWorkerInstallationIdDigestV1(): string {
  return installationIdDigestV1(app.getPath('userData'))
}

export function closeDefaultHubTaskWorkerServiceV1(): void {
  defaultService?.close()
  defaultService = null
}
