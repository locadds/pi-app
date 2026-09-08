import { app } from 'electron'
import { join } from 'node:path'

import {
  DocumentReviewRendererV1,
} from './work-document-review-renderer'
import { WordPrivateConverterV1 } from './work-word-private-converter'
import { TemplateReviewReplacementImageStoreV1 } from './work-document-review-image-store'

let defaultRenderer: DocumentReviewRendererV1 | null = null
let defaultImageStore: TemplateReviewReplacementImageStoreV1 | null = null
let rendererShutdownRegistered = false

export function getDefaultDocumentReviewRendererV1(): DocumentReviewRendererV1 {
  if (!defaultRenderer) {
    defaultRenderer = new DocumentReviewRendererV1({
      converter: new WordPrivateConverterV1({
        scriptPath: join(
          app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
          'word-converter',
          'convert-doc.ps1',
        ),
        privateRoot:
          process.env.XIAOGUI_DOCUMENT_REVIEW_TEMP_ROOT ??
          join(app.getPath('temp'), 'xiaogui-document-review', 'v1'),
        timeoutMs: 120_000,
      }),
    })
  }
  if (!rendererShutdownRegistered) {
    rendererShutdownRegistered = true
    app.once('before-quit', () => {
      defaultRenderer?.close()
      defaultRenderer = null
      rendererShutdownRegistered = false
    })
  }
  return defaultRenderer
}

export function getDefaultTemplateReviewReplacementImageStoreV1(): TemplateReviewReplacementImageStoreV1 {
  defaultImageStore ??= new TemplateReviewReplacementImageStoreV1(
    join(app.getPath('userData'), 'xiaogui', 'template-review-assets', 'v1'),
  )
  return defaultImageStore
}
