import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  packaged: false,
  word: vi.fn(),
  renderer: vi.fn(),
}))
vi.mock('electron', () => ({ app: {
  get isPackaged() { return mocks.packaged },
  getAppPath: () => 'C:/application',
  getPath: () => 'C:/private-temp',
  once: vi.fn(),
} }))
vi.mock('./work-word-private-converter', () => ({
  WordPrivateConverterV1: class { constructor(config: unknown) { mocks.word(config) } },
}))
vi.mock('./work-document-review-renderer', () => ({
  DocumentReviewRendererV1: class { constructor(config: unknown) { mocks.renderer(config) } },
}))
vi.mock('./work-document-review-image-store', () => ({ TemplateReviewReplacementImageStoreV1: class {} }))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it.each([false, true])('composes Word without LibreOffice fallback, packaged=%s', async (packaged) => {
  vi.resetModules()
  mocks.packaged = packaged
  vi.stubGlobal('process', { ...process, resourcesPath: 'C:/installed/resources' })
  const { getDefaultDocumentReviewRendererV1 } = await import('./work-document-review-renderer-composition')
  getDefaultDocumentReviewRendererV1()
  expect(mocks.word).toHaveBeenCalledTimes(1)
  const config = mocks.word.mock.calls[0][0]
  expect(config.scriptPath.replaceAll('\\', '/')).toBe(
    `${packaged ? 'C:/installed/resources' : 'C:/application/resources'}/word-converter/convert-doc.ps1`,
  )
  expect(mocks.renderer).toHaveBeenCalledWith({ converter: expect.any(Object) })
})
