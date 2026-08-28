import { z } from 'zod'

import { registerHandler, registerHandlerWithSchema } from '../ipc/registry'
import {
  chooseAndConfigureDefaultTemplateLibraryV1,
  getDefaultTemplateLibraryServiceV1,
} from './template-library-composition'
import { TemplateLibraryPreviewServiceV1 } from './template-library-preview-service'
import { getDefaultDocumentReviewRendererV1 } from './work-document-review-renderer-composition'

const EntrySchema = z.object({ entryId: z.string().min(1).max(160) }).strict()
const PreviewPrepareSchema = z.object({ versionId: z.string().min(1).max(160) }).strict()
const PreviewReleaseSchema = z.object({ manifestId: z.string().uuid() }).strict()
const ListSchema = z
  .object({
    query: z.string().max(200).optional(),
    tags: z.array(z.string().max(32)).max(20).optional(),
    status: z.enum(['ACTIVE', 'TRASHED', 'ALL']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict()

let defaultPreviewService: TemplateLibraryPreviewServiceV1 | null = null

function getDefaultTemplateLibraryPreviewServiceV1(): TemplateLibraryPreviewServiceV1 {
  defaultPreviewService ??= new TemplateLibraryPreviewServiceV1({
    templateLibrary: getDefaultTemplateLibraryServiceV1(),
    documentReviewRenderer: getDefaultDocumentReviewRendererV1(),
  })
  return defaultPreviewService
}

export function registerTemplateLibraryHandlersV1(): void {
  registerHandler('ipc:xiaogui.templateLibrary.configuration.get', async () =>
    getDefaultTemplateLibraryServiceV1().getConfiguration(),
  )
  registerHandler('ipc:xiaogui.templateLibrary.configuration.choose', async () =>
    chooseAndConfigureDefaultTemplateLibraryV1(),
  )
  registerHandlerWithSchema('ipc:xiaogui.templateLibrary.list', ListSchema, async (query) =>
    getDefaultTemplateLibraryServiceV1().list(query),
  )
  registerHandlerWithSchema('ipc:xiaogui.templateLibrary.detail', EntrySchema, async ({ entryId }) =>
    getDefaultTemplateLibraryServiceV1().getDetail(entryId),
  )
  registerHandler('ipc:xiaogui.templateLibrary.usage', async () =>
    getDefaultTemplateLibraryServiceV1().getUsage(),
  )
  registerHandlerWithSchema('ipc:xiaogui.templateLibrary.trash', EntrySchema, async ({ entryId }) =>
    getDefaultTemplateLibraryServiceV1().moveToTrash(entryId),
  )
  registerHandlerWithSchema('ipc:xiaogui.templateLibrary.restore', EntrySchema, async ({ entryId }) =>
    getDefaultTemplateLibraryServiceV1().restore(entryId),
  )
  registerHandlerWithSchema('ipc:xiaogui.templateLibrary.purge', EntrySchema, async ({ entryId }) => {
    await getDefaultTemplateLibraryServiceV1().purgeTrashed(entryId)
    return { deleted: true }
  })
  registerHandlerWithSchema(
    'ipc:xiaogui.templateLibrary.preview.prepare',
    PreviewPrepareSchema,
    async ({ versionId }) => getDefaultTemplateLibraryPreviewServiceV1().prepare(versionId),
  )
  registerHandlerWithSchema(
    'ipc:xiaogui.templateLibrary.preview.release',
    PreviewReleaseSchema,
    async ({ manifestId }) => getDefaultTemplateLibraryPreviewServiceV1().release(manifestId),
  )
}
