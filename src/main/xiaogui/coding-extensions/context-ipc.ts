import { z } from 'zod'

import type {
  CodingContextSnapshotOutcomeV1,
  CodingContextSnapshotRequestV1,
} from '@shared/xiaogui-coding-extension-pack'
import { registerHandlerWithSchema } from '../../ipc/registry'
import { codingContextModuleV1 } from './context-composition'
import { CodingContextModuleV1 } from './context-module'

const requestSchema = z.object({
  address: z.object({
    projectId: z.string().trim().min(1),
    sessionKey: z.string().trim().min(1),
  }).strict(),
  relativePaths: z.array(z.string().trim().min(1)).min(1).max(20),
}).strict()

export function registerCodingContextHandlersV1(
  module: CodingContextModuleV1 = codingContextModuleV1,
): void {
  registerHandlerWithSchema(
    'ipc:xiaogui.coding.context.snapshot',
    requestSchema,
    async (request): Promise<CodingContextSnapshotOutcomeV1> => {
      try {
        return {
          ok: true,
          snapshot: await module.snapshot(request as unknown as CodingContextSnapshotRequestV1),
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (code === 'CODING_CONTEXT_OUTSIDE_WORKSPACE') return { ok: false, error: 'OUTSIDE_WORKSPACE' }
        if (code === 'CODING_CONTEXT_SOURCE_NOT_FOUND') return { ok: false, error: 'SOURCE_NOT_FOUND' }
        if (code === 'CODING_CONTEXT_FILE_REQUIRED') return { ok: false, error: 'SOURCE_NOT_FILE' }
        if (code.startsWith('CODING_CONTEXT_')) return { ok: false, error: 'INVALID_REQUEST' }
        return { ok: false, error: 'SNAPSHOT_FAILED' }
      }
    },
  )
}
