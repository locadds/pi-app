import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  DocumentReviewRendererV1,
  LibreOfficePrivateConverterV1,
} from './work-document-review-renderer'
import { TemplateReviewReplacementImageStoreV1 } from './work-document-review-image-store'

let defaultRenderer: DocumentReviewRendererV1 | null = null
let defaultImageStore: TemplateReviewReplacementImageStoreV1 | null = null
let rendererShutdownRegistered = false

function libreOfficeExecutablePath(): string {
  const executable = process.platform === 'win32' ? 'soffice.exe' : 'soffice'
  const candidates = [
    process.env.XIAOGUI_LIBREOFFICE_PATH,
    join(process.resourcesPath, 'libreoffice', 'program', executable),
    join(
      app.getAppPath(),
      'resources',
      'libreoffice-runtime',
      'runtime',
      'program',
      executable,
    ),
    join(app.getAppPath(), 'resources', 'libreoffice-runtime', 'program', executable),
    process.platform === 'win32'
      ? join('C:\\Program Files', 'LibreOffice', 'program', executable)
      : '/usr/bin/soffice',
  ].filter((value): value is string => Boolean(value))
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export function getDefaultDocumentReviewRendererV1(): DocumentReviewRendererV1 {
  if (!defaultRenderer) {
    defaultRenderer = new DocumentReviewRendererV1({
      converter: new LibreOfficePrivateConverterV1({
        executablePath: libreOfficeExecutablePath(),
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
