import { app } from 'electron'

import { createHttpXiaoguiHubTaskWorkerPortV1 } from './http-task-worker-port'
import { createHubTaskWorkerCredentialsV1 } from './worker-credentials'
import { createPersistentHubTaskWorkerStateStoreV1 } from './worker-persistence'
import {
  createHubTaskWorkerServiceV1,
  type CreateHubTaskWorkerServiceOptionsV1,
  type HubTaskWorkerServiceV1,
} from './worker-service'
import {
  getDefaultCollaborationHubApplication,
  getDefaultHubTaskAcceptAndExecuteTrustedPortV2,
} from '../task-hub/ipc'
import { installationIdDigestV1 } from './worker-installation'

let defaultService: HubTaskWorkerServiceV1 | null = null

/**
 * The production Worker composition is deliberately a thin dependency seam:
 * callers may provide the existing state, credentials, Hub transport,
 * Application and trusted TaskHub port, while service authorization remains
 * the real Hub Worker implementation.
 */
export type HubTaskWorkerCompositionDependenciesV1 = Pick<
  CreateHubTaskWorkerServiceOptionsV1,
  'state' | 'credentials' | 'createPort' | 'application'
> & {
  acceptAndExecuteV2: NonNullable<CreateHubTaskWorkerServiceOptionsV1['acceptAndExecuteV2']>
}

export function createHubTaskWorkerCompositionV1(
  dependencies: HubTaskWorkerCompositionDependenciesV1,
): HubTaskWorkerServiceV1 {
  return createHubTaskWorkerServiceV1(dependencies)
}

export function getDefaultHubTaskWorkerServiceV1(): HubTaskWorkerServiceV1 {
  if (defaultService) return defaultService
  const service = createHubTaskWorkerCompositionV1({
    state: createPersistentHubTaskWorkerStateStoreV1(),
    credentials: createHubTaskWorkerCredentialsV1(),
    application: getDefaultCollaborationHubApplication(),
    createPort: (credentials) =>
      createHttpXiaoguiHubTaskWorkerPortV1({
        endpoint: credentials.endpoint,
        accessToken: credentials.accessToken,
        ...('node' in credentials ? { node: { deviceToken: credentials.node.deviceToken } } : {}),
      }),
    // Keep the Worker and TaskHub on the same default runtime lifecycle. The
    // trusted port owns target/authority checks and execution; this composition
    // only wires it into the already persistent Worker service.
    acceptAndExecuteV2: getDefaultHubTaskAcceptAndExecuteTrustedPortV2(),
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
