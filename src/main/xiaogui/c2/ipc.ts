import { z } from 'zod'

import { registerHandler, registerHandlerWithSchema } from '../../ipc/registry'
import { getC2ArtifactInstallCoordinatorV1, openLastInstalledC2StaticAppV1 } from './composition'

const IntentSchema = z.object({ installIntentId: z.string().uuid() }).strict()

export function registerC2ArtifactInstallHandlersV1(): void {
  registerHandler('ipc:xiaogui.c2.status', async () => getC2ArtifactInstallCoordinatorV1().status())
  registerHandlerWithSchema('ipc:xiaogui.c2.confirm', IntentSchema, async ({ installIntentId }) => (
    getC2ArtifactInstallCoordinatorV1().confirm(installIntentId)
  ))
  registerHandlerWithSchema('ipc:xiaogui.c2.cancel', IntentSchema, async ({ installIntentId }) => (
    getC2ArtifactInstallCoordinatorV1().cancel(installIntentId)
  ))
  registerHandler('ipc:xiaogui.c2.app.open', async () => ({ ok: openLastInstalledC2StaticAppV1() }))
}
