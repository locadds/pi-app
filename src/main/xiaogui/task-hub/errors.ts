import { randomUUID } from 'node:crypto'

import type { HubErrorCodeV1, HubOutcomeV1, HubSafeErrorV1 } from '@shared/xiaogui-collaboration-hub'

export function hubError(
  code: HubErrorCodeV1,
  safeArgs?: HubSafeErrorV1['safeArgs'],
): HubOutcomeV1<never> {
  return {
    ok: false,
    error: {
      code,
      messageKey: `xiaogui.hub.${code.toLowerCase()}`,
      ...(safeArgs ? { safeArgs } : {}),
      traceId: `xhbt_${randomUUID()}`,
    },
  }
}
