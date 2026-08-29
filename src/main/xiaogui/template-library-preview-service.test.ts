import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  TemplateLibrarySummaryV1,
  TemplateLibraryVersionSummaryV1,
} from '@shared/xiaogui-template-library'

import { TemplateLibraryPreviewServiceV1 } from './template-library-preview-service'
import type {
  DocumentReviewRendererV1,
  PreparedDocumentReviewRenderV1,
} from './work-document-review-renderer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function versionSummary(): TemplateLibraryVersionSummaryV1 {
  return {
    versionId: 'version-1',
    versionNumber: 1,
    sha256: 'a'.repeat(64),
    byteLength: 21,
    fields: [],
    createdAt: '2026-08-28T10:00:00.000Z',
    isLatest: true,
  }
}

function entrySummary(version: TemplateLibraryVersionSummaryV1): TemplateLibrarySummaryV1 {
  return {
    libraryVersion: 1,
    entryId: 'entry-1',
    name: '项目周报模板',
    tags: ['周报'],
    fields: [],
    status: 'ACTIVE',
    latestVersion: version,
    versionCount: 1,
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
  }
}

describe('TemplateLibraryPreviewServiceV1', () => {
  it('keeps the resolved path and source buffer private, then releases only its own manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaogui-library-preview-'))
    roots.push(root)
    const assetPath = join(root, 'private-template.docx')
    const sourceBytes = Buffer.from('PRIVATE_DOCX_CONTENT')
    await writeFile(assetPath, sourceBytes)

    const version = versionSummary()
    const resolveVersionForUse = vi.fn(async () => ({
      entry: entrySummary(version),
      version,
      assetPath,
    }))
    const prepared: PreparedDocumentReviewRenderV1 = {
      manifestId: '8a11fa90-09dc-40da-aa18-3f1283350618',
      sourceSha256: 'a'.repeat(64),
      normalizedDocxAvailable: true,
      render: {
        mode: 'DOCX_HTML',
        documentToken: 'opaque-docx-token-without-a-path',
        paginationBasis: 'DOCX_STORED_BREAKS',
        approximatePageCount: 1,
        warnings: [],
      },
      projections: [],
    }
    const prepare: DocumentReviewRendererV1['prepare'] = vi.fn(async (content, inputFormat) => {
      expect(inputFormat).toBe('DOCX')
      expect(content).toEqual(sourceBytes)
      return prepared
    })
    const release: DocumentReviewRendererV1['release'] = vi.fn(() => true)
    const service = new TemplateLibraryPreviewServiceV1({
      templateLibrary: { resolveVersionForUse },
      documentReviewRenderer: { prepare, release },
    })

    const preview = await service.prepare(version.versionId)

    expect(resolveVersionForUse).toHaveBeenCalledWith(version.versionId)
    expect(preview).toMatchObject({
      previewVersion: 1,
      manifestId: prepared.manifestId,
      entryId: 'entry-1',
      entryName: '项目周报模板',
      versionId: version.versionId,
      versionNumber: 1,
      render: { mode: 'DOCX_HTML', documentToken: 'opaque-docx-token-without-a-path' },
    })
    expect(JSON.stringify(preview)).not.toContain(assetPath)
    expect(JSON.stringify(preview)).not.toContain(sourceBytes.toString())

    expect(service.release('b7210677-cda8-4b9e-b9f2-d6a0c919b901')).toEqual({ released: false })
    expect(release).not.toHaveBeenCalled()
    expect(service.release(prepared.manifestId)).toEqual({ released: true })
    expect(release).toHaveBeenCalledOnce()
    expect(service.release(prepared.manifestId)).toEqual({ released: false })
    expect(release).toHaveBeenCalledOnce()
  })
})
