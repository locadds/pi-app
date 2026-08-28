import { readFile } from 'node:fs/promises'

import {
  TEMPLATE_LIBRARY_PREVIEW_VERSION_V1,
  type TemplateLibraryPreviewReleaseResultV1,
  type TemplateLibraryPreviewV1,
} from '@shared/xiaogui-template-library'

import type { TemplateLibraryServiceV1 } from './template-library-service'
import type { DocumentReviewRendererV1 } from './work-document-review-renderer'

export interface TemplateLibraryPreviewServiceOptionsV1 {
  templateLibrary: Pick<TemplateLibraryServiceV1, 'resolveVersionForUse'>
  documentReviewRenderer: Pick<DocumentReviewRendererV1, 'prepare' | 'release'>
}

/**
 * 主进程私有接缝：模板路径和源 Buffer 只在此处短暂存在，Renderer 仅收到
 * 无路径的临时令牌。服务只允许释放自己创建的 manifest。
 */
export class TemplateLibraryPreviewServiceV1 {
  private readonly ownedManifestIds = new Set<string>()

  constructor(private readonly options: TemplateLibraryPreviewServiceOptionsV1) {}

  async prepare(versionId: string): Promise<TemplateLibraryPreviewV1> {
    const resolved = await this.options.templateLibrary.resolveVersionForUse(versionId)
    const source = await readFile(resolved.assetPath)
    try {
      const prepared = await this.options.documentReviewRenderer.prepare(source, 'DOCX')
      this.ownedManifestIds.add(prepared.manifestId)
      return {
        previewVersion: TEMPLATE_LIBRARY_PREVIEW_VERSION_V1,
        manifestId: prepared.manifestId,
        entryId: resolved.entry.entryId,
        entryName: resolved.entry.name,
        versionId: resolved.version.versionId,
        versionNumber: resolved.version.versionNumber,
        render: prepared.render,
      }
    } finally {
      source.fill(0)
    }
  }

  release(manifestId: string): TemplateLibraryPreviewReleaseResultV1 {
    if (!this.ownedManifestIds.delete(manifestId)) return { released: false }
    return { released: this.options.documentReviewRenderer.release(manifestId) }
  }
}
