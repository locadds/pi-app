import { z } from 'zod'
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'

import { registerHandler, registerHandlerWithSchema } from '../ipc/registry'
import {
  getDefaultDocumentReviewRendererV1,
  getDefaultTemplateReviewReplacementImageStoreV1,
} from './work-document-review-renderer-composition'

const PageRequestSchema = z.object({ pageToken: z.string().min(16).max(256) }).strict()

export function registerDocumentReviewHandlersV1(): void {
  registerHandlerWithSchema(
    'ipc:xiaogui.templateReview.page.read',
    PageRequestSchema,
    async ({ pageToken }) => getDefaultDocumentReviewRendererV1().readPageAssetByToken(pageToken),
  )
  registerHandler('ipc:xiaogui.templateReview.image.choose', async () => {
    const options: OpenDialogOptions = {
      title: '选择替换图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
    }
    const window = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { cancelled: true as const }
    const imported = await getDefaultTemplateReviewReplacementImageStoreV1()
      .importFromPath(result.filePaths[0])
    return { cancelled: false as const, ...imported }
  })
}
