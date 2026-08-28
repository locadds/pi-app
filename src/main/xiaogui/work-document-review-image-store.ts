import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const TOKEN_RE = /^xgtri1_[0-9a-f-]{36}$/i

export type TemplateReviewReplacementImageV1 = {
  content: Buffer
  extension: 'png' | 'jpg' | 'jpeg'
  contentType: string
}

type ImageMetadataV1 = {
  version: 1
  token: string
  displayName: string
  extension: TemplateReviewReplacementImageV1['extension']
  contentType: string
}

function inspectImage(content: Buffer, extension: string): Omit<TemplateReviewReplacementImageV1, 'content'> {
  const normalized = extension === '.jpeg' ? 'jpeg' : extension.slice(1)
  if (normalized === 'png' && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', contentType: 'image/png' }
  }
  if ((normalized === 'jpg' || normalized === 'jpeg') && content[0] === 0xff && content[1] === 0xd8 && content.at(-2) === 0xff && content.at(-1) === 0xd9) {
    return { extension: normalized, contentType: 'image/jpeg' }
  }
  throw new Error('TEMPLATE_REVIEW_REPLACEMENT_IMAGE_INVALID')
}

export class TemplateReviewReplacementImageStoreV1 {
  constructor(
    private readonly root: string,
    private readonly createUuid: () => string = randomUUID,
  ) {}

  async importFromPath(path: string): Promise<{ token: string; displayName: string }> {
    const information = await lstat(path)
    if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_IMAGE_BYTES) {
      throw new Error('TEMPLATE_REVIEW_REPLACEMENT_IMAGE_INVALID')
    }
    const content = await readFile(path)
    const inspected = inspectImage(content, extname(path).toLowerCase())
    const token = `xgtri1_${this.createUuid()}`
    if (!TOKEN_RE.test(token)) throw new Error('TEMPLATE_REVIEW_REPLACEMENT_IMAGE_INVALID')
    const displayName = basename(path).slice(0, 160)
    await mkdir(this.root, { recursive: true })
    const assetPath = join(this.root, `${token}.${inspected.extension}`)
    const metadataPath = join(this.root, `${token}.json`)
    const temporaryAsset = `${assetPath}.tmp`
    const temporaryMetadata = `${metadataPath}.tmp`
    const metadata: ImageMetadataV1 = {
      version: 1,
      token,
      displayName,
      ...inspected,
    }
    let temporaryAssetCreated = false
    let temporaryMetadataCreated = false
    let assetPublished = false
    let metadataPublished = false
    try {
      await writeFile(temporaryAsset, content, { flag: 'wx' })
      temporaryAssetCreated = true
      await writeFile(temporaryMetadata, JSON.stringify(metadata), { flag: 'wx' })
      temporaryMetadataCreated = true
      await rename(temporaryAsset, assetPath)
      temporaryAssetCreated = false
      assetPublished = true
      await rename(temporaryMetadata, metadataPath)
      temporaryMetadataCreated = false
      metadataPublished = true
      return { token, displayName }
    } catch (error) {
      if (temporaryAssetCreated) await unlink(temporaryAsset).catch(() => {})
      if (temporaryMetadataCreated) await unlink(temporaryMetadata).catch(() => {})
      if (assetPublished) await unlink(assetPath).catch(() => {})
      if (metadataPublished) await unlink(metadataPath).catch(() => {})
      throw error
    }
  }

  async resolve(token: string): Promise<TemplateReviewReplacementImageV1> {
    if (!TOKEN_RE.test(token)) throw new Error('TEMPLATE_REVIEW_REPLACEMENT_IMAGE_INVALID')
    const metadata = JSON.parse(
      await readFile(join(this.root, `${token}.json`), 'utf8'),
    ) as ImageMetadataV1
    if (metadata.version !== 1 || metadata.token !== token) {
      throw new Error('TEMPLATE_REVIEW_REPLACEMENT_IMAGE_INVALID')
    }
    const content = await readFile(join(this.root, `${token}.${metadata.extension}`))
    const inspected = inspectImage(content, `.${metadata.extension}`)
    return { content, ...inspected }
  }
}
