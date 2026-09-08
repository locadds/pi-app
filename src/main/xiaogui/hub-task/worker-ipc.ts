import { z } from 'zod'

import { registerHandler } from '../../ipc/registry'
import type { HubTaskWorkerServiceV1 } from './worker-service'
import {
  HubTaskWorkerHttpErrorV1,
  loginHubTaskWorkerAccountV1,
  type HubTaskWorkerAccountLoginInputV1,
} from './http-task-worker-port'

const ConnectSchema = z.object({
  endpoint: z.string().min(1).max(2_048),
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(256),
}).strict()
/**
 * Renderer-facing Hub Worker bridge. Credential material stays solely in the
 * main-process safeStorage record; public values intentionally contain no
 * endpoint, subject, node, key, token, private key, local path, or TaskHub
 * session/flow identifier.
 */
export function registerHubTaskWorkerHandlers(
  service: HubTaskWorkerServiceV1,
  installationIdDigest: string,
  login: (input: HubTaskWorkerAccountLoginInputV1) => Promise<{ endpoint: string; accessToken: string }> = loginHubTaskWorkerAccountV1,
): void {
  registerHandler('ipc:xiaogui.hubTask.status', async () => ({ ok: true as const, value: service.status() }))

  registerHandler('ipc:xiaogui.hubTask.connect', async (payload) => {
    const parsed = ConnectSchema.safeParse(payload)
    if (!parsed.success) return invalidInput()
    try {
      const session = await login(parsed.data)
      return service.connect({ ...session, installationIdDigest })
    } catch (error) {
      return {
        ok: false as const,
        code: error instanceof HubTaskWorkerHttpErrorV1 && error.code === 'AUTHENTICATION_FAILED'
          ? 'HUB_WORKER_AUTHENTICATION_FAILED' as const
          : 'HUB_WORKER_CONNECTION_FAILED' as const,
      }
    }
  })

}

function invalidInput() {
  return { ok: false as const, code: 'HUB_WORKER_INPUT_INVALID' as const }
}
